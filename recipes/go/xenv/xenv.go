// Package xenv is a minimal-but-complete recipe for the xenv
// encrypted-environment format. Generated from ../../README.md.
//
// Three operations: Get (read one), Set (write one), Load (read all).
// No rotate, no init, no edit — those are the shell tool's job.
//
// Crypto: stdlib (crypto/aes, crypto/cipher, crypto/hmac, crypto/sha256,
// crypto/rand) plus golang.org/x/crypto/pbkdf2 for the KDF.
package xenv

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/crypto/hkdf"
	"golang.org/x/crypto/pbkdf2"
)

const (
	vaultVersion = "v3"
	valueExt     = ".value.enc"
)

func root() string {
	if r := os.Getenv("XENV_ROOT"); r != "" {
		return r
	}
	return "xenv"
}

func envVarName(envName string) string {
	return "XENV_KEY_" + strings.ReplaceAll(strings.ToUpper(envName), "-", "_")
}

func passphrase(envName string) (string, error) {
	if v := os.Getenv(envVarName(envName)); v != "" {
		return v, nil
	}
	if v := os.Getenv("XENV_KEY"); v != "" {
		return v, nil
	}
	return "", fmt.Errorf("no passphrase: set $%s or $XENV_KEY", envVarName(envName))
}

type params struct {
	iter int
	salt string
}

// readParams parses the per-env README frontmatter — naive split-on-first-colon.
func readParams(envName string) (*params, error) {
	readme := filepath.Join(root(), "envs", envName, "README.md")
	data, err := os.ReadFile(readme)
	if err != nil {
		return nil, err
	}
	found := map[string]string{}
	inBlock := false
	for _, line := range strings.Split(string(data), "\n") {
		if line == "---" {
			if !inBlock {
				inBlock = true
				continue
			}
			break
		}
		if !inBlock {
			continue
		}
		stripped := strings.TrimSpace(line)
		if stripped == "" || strings.HasPrefix(stripped, "#") {
			continue
		}
		colon := strings.Index(stripped, ":")
		if colon < 0 {
			continue
		}
		k := strings.TrimSpace(stripped[:colon])
		v := strings.TrimSpace(stripped[colon+1:])
		found[k] = v
	}

	if found["version"] != vaultVersion {
		return nil, fmt.Errorf("params: unsupported or missing version: %q", found["version"])
	}
	salt := found["salt"]
	if len(salt) != 32 {
		return nil, errors.New("params: invalid salt length")
	}
	if _, err := hex.DecodeString(salt); err != nil {
		return nil, errors.New("params: non-hex salt")
	}
	iter, err := strconv.Atoi(found["iter"])
	if err != nil || iter <= 0 {
		return nil, errors.New("params: invalid iter")
	}
	return &params{iter: iter, salt: salt}, nil
}

// pbkdf2Okm returns the raw 64-byte PBKDF2 output (the env "master").
func pbkdf2Okm(pass, saltHex string, iter int) ([]byte, error) {
	salt, err := hex.DecodeString(saltHex)
	if err != nil {
		return nil, err
	}
	return pbkdf2.Key([]byte(pass), salt, iter, 64, sha256.New), nil
}

func deriveKeys(pass, saltHex string, iter int) (encKey, macKey []byte, err error) {
	okm, err := pbkdf2Okm(pass, saltHex, iter)
	if err != nil {
		return nil, nil, err
	}
	return okm[:32], okm[32:], nil
}

// Dual-read v3/v4/v5. Caller precomputes envOkm = PBKDF2 over the env
// README salt/iter ONCE; per value it's a slice (v3) or a cheap HKDF (v5).
func decryptEnvelope(envelope, passphrase, ctxSalt string, ctxIter int, envOkm []byte) ([]byte, error) {
	parts := strings.Split(strings.TrimSpace(envelope), ":")
	if len(parts) < 2 || parts[0] != "xenv" {
		return nil, errors.New("envelope: not xenv")
	}

	var encKey, macKey []byte
	var ivHex, ctHex, macHex, macScope string
	switch parts[1] {
	case "v3":
		if len(parts) != 5 {
			return nil, errors.New("envelope: wrong field count")
		}
		ivHex, ctHex, macHex = parts[2], parts[3], parts[4]
		encKey, macKey = envOkm[:32], envOkm[32:]
		macScope = fmt.Sprintf("v3:%s:%s", ivHex, ctHex)
	case "v4":
		if len(parts) != 7 {
			return nil, errors.New("envelope: wrong field count")
		}
		saltHex, iterStr := parts[2], parts[3]
		ivHex, ctHex, macHex = parts[4], parts[5], parts[6]
		if len(saltHex) != 32 {
			return nil, errors.New("envelope: bad salt")
		}
		iter, err := strconv.Atoi(iterStr)
		if err != nil || iter < 1 || iter > 10_000_000 {
			return nil, errors.New("envelope: bad iter")
		}
		okm, err := pbkdf2Okm(passphrase, saltHex, iter)
		if err != nil {
			return nil, err
		}
		encKey, macKey = okm[:32], okm[32:]
		macScope = fmt.Sprintf("v4:%s:%s:%s:%s", saltHex, iterStr, ivHex, ctHex)
	case "v5":
		if len(parts) != 8 {
			return nil, errors.New("envelope: wrong field count")
		}
		kdfSalt, iterStr, valueSalt := parts[2], parts[3], parts[4]
		ivHex, ctHex, macHex = parts[5], parts[6], parts[7]
		if len(kdfSalt) != 32 || len(valueSalt) != 32 {
			return nil, errors.New("envelope: bad salt")
		}
		iter, err := strconv.Atoi(iterStr)
		if err != nil || iter < 1 || iter > 10_000_000 {
			return nil, errors.New("envelope: bad iter")
		}
		ikm := envOkm
		if kdfSalt != ctxSalt || iter != ctxIter {
			if ikm, err = pbkdf2Okm(passphrase, kdfSalt, iter); err != nil {
				return nil, err
			}
		}
		vs, err := hex.DecodeString(valueSalt)
		if err != nil {
			return nil, errors.New("envelope: non-hex salt")
		}
		okm := make([]byte, 64)
		if _, err := io.ReadFull(hkdf.New(sha256.New, ikm, vs, []byte("xenv:v5")), okm); err != nil {
			return nil, err
		}
		encKey, macKey = okm[:32], okm[32:]
		macScope = fmt.Sprintf("v5:%s:%s:%s:%s:%s", kdfSalt, iterStr, valueSalt, ivHex, ctHex)
	default:
		return nil, fmt.Errorf("envelope: unsupported version %s", parts[1])
	}

	if len(ivHex) != 32 || len(macHex) != 64 {
		return nil, errors.New("envelope: wrong iv/mac length")
	}
	if len(ctHex) == 0 || len(ctHex)%32 != 0 {
		return nil, errors.New("envelope: ct not block-aligned")
	}
	iv, err := hex.DecodeString(ivHex)
	if err != nil {
		return nil, errors.New("envelope: non-hex iv")
	}
	ct, err := hex.DecodeString(ctHex)
	if err != nil {
		return nil, errors.New("envelope: non-hex ct")
	}
	providedMac, err := hex.DecodeString(macHex)
	if err != nil {
		return nil, errors.New("envelope: non-hex mac")
	}

	// MAC verify FIRST (encrypt-then-MAC; constant-time compare)
	h := hmac.New(sha256.New, macKey)
	h.Write([]byte(macScope))
	expected := h.Sum(nil)
	if !hmac.Equal(expected, providedMac) {
		return nil, errors.New("MAC verification failed — wrong key or tampered vault")
	}

	block, err := aes.NewCipher(encKey)
	if err != nil {
		return nil, err
	}
	if len(ct)%block.BlockSize() != 0 {
		return nil, errors.New("envelope: ciphertext not block-aligned")
	}
	mode := cipher.NewCBCDecrypter(block, iv)
	plain := make([]byte, len(ct))
	mode.CryptBlocks(plain, ct)

	// strip PKCS#7 padding
	if len(plain) == 0 {
		return nil, errors.New("envelope: empty plaintext after decrypt")
	}
	pad := int(plain[len(plain)-1])
	if pad < 1 || pad > block.BlockSize() || pad > len(plain) {
		return nil, errors.New("envelope: invalid PKCS#7 padding")
	}
	for _, b := range plain[len(plain)-pad:] {
		if int(b) != pad {
			return nil, errors.New("envelope: invalid PKCS#7 padding")
		}
	}
	return plain[:len(plain)-pad], nil
}

func encryptEnvelope(plaintext, encKey, macKey []byte) (string, error) {
	block, err := aes.NewCipher(encKey)
	if err != nil {
		return "", err
	}
	iv := make([]byte, block.BlockSize())
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}

	// PKCS#7 pad
	bs := block.BlockSize()
	pad := bs - (len(plaintext) % bs)
	padded := make([]byte, len(plaintext)+pad)
	copy(padded, plaintext)
	for i := len(plaintext); i < len(padded); i++ {
		padded[i] = byte(pad)
	}

	ct := make([]byte, len(padded))
	mode := cipher.NewCBCEncrypter(block, iv)
	mode.CryptBlocks(ct, padded)

	ivHex := hex.EncodeToString(iv)
	ctHex := hex.EncodeToString(ct)
	macScope := fmt.Sprintf("%s:%s:%s", vaultVersion, ivHex, ctHex)
	h := hmac.New(sha256.New, macKey)
	h.Write([]byte(macScope))
	macHex := hex.EncodeToString(h.Sum(nil))

	return fmt.Sprintf("xenv:%s:%s:%s:%s\n", vaultVersion, ivHex, ctHex, macHex), nil
}

func atomicWrite(dest, content string) error {
	tmp := dest + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, dest)
}

// Get decrypts and returns the plaintext for one key.
func Get(envName, key string) ([]byte, error) {
	p, err := readParams(envName)
	if err != nil {
		return nil, err
	}
	pass, err := passphrase(envName)
	if err != nil {
		return nil, err
	}
	envOkm, err := pbkdf2Okm(pass, p.salt, p.iter)
	if err != nil {
		return nil, err
	}
	file := filepath.Join(root(), "envs", envName, key+valueExt)
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("no such key: %s", key)
	}
	return decryptEnvelope(string(data), pass, p.salt, p.iter, envOkm)
}

// Set encrypts plaintext and atomically writes it.
// Reuses the env's existing salt and iter; only a fresh IV is generated.
func Set(envName, key string, plaintext []byte) error {
	p, err := readParams(envName)
	if err != nil {
		return err
	}
	pass, err := passphrase(envName)
	if err != nil {
		return err
	}
	encKey, macKey, err := deriveKeys(pass, p.salt, p.iter)
	if err != nil {
		return err
	}
	envDir := filepath.Join(root(), "envs", envName)
	if info, err := os.Stat(envDir); err != nil || !info.IsDir() {
		return fmt.Errorf("no env directory: %s", envDir)
	}
	envelope, err := encryptEnvelope(plaintext, encKey, macKey)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(envDir, key+valueExt), envelope)
}

// Load returns a map of every variable in the named env to its decrypted bytes.
func Load(envName string) (map[string][]byte, error) {
	p, err := readParams(envName)
	if err != nil {
		return nil, err
	}
	pass, err := passphrase(envName)
	if err != nil {
		return nil, err
	}
	envOkm, err := pbkdf2Okm(pass, p.salt, p.iter)
	if err != nil {
		return nil, err
	}
	envDir := filepath.Join(root(), "envs", envName)
	entries, err := os.ReadDir(envDir)
	if err != nil {
		return nil, err
	}
	out := map[string][]byte{}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, valueExt) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(envDir, name))
		if err != nil {
			return nil, err
		}
		plain, err := decryptEnvelope(string(data), pass, p.salt, p.iter, envOkm)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		out[strings.TrimSuffix(name, valueExt)] = plain
	}
	return out, nil
}
