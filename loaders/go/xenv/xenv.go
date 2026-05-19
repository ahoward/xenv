// Package xenv is a read-only loader for the xenv encrypted-environment
// format. Generated from ../AGENT_PROMPT.md as a reference implementation.
//
// Crypto: stdlib (crypto/aes, crypto/cipher, crypto/hmac, crypto/sha256)
// plus golang.org/x/crypto/pbkdf2 for the KDF. No third-party dep beyond
// the well-known x/crypto subrepo.
package xenv

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

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

func deriveKeys(pass, saltHex string, iter int) (encKey, macKey []byte, err error) {
	salt, err := hex.DecodeString(saltHex)
	if err != nil {
		return nil, nil, err
	}
	derived := pbkdf2.Key([]byte(pass), salt, iter, 64, sha256.New)
	return derived[:32], derived[32:], nil
}

func decryptEnvelope(envelope string, encKey, macKey []byte) ([]byte, error) {
	parts := strings.Split(strings.TrimSpace(envelope), ":")
	if len(parts) != 5 {
		return nil, errors.New("envelope: wrong field count")
	}
	tag, ver, ivHex, ctHex, macHex := parts[0], parts[1], parts[2], parts[3], parts[4]
	if tag != "xenv" || ver != vaultVersion {
		return nil, fmt.Errorf("envelope: unsupported %s:%s", tag, ver)
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
	macScope := fmt.Sprintf("%s:%s:%s", vaultVersion, ivHex, ctHex)
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
	encKey, macKey, err := deriveKeys(pass, p.salt, p.iter)
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
		plain, err := decryptEnvelope(string(data), encKey, macKey)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		out[strings.TrimSuffix(name, valueExt)] = plain
	}
	return out, nil
}

// DecryptOne returns the plaintext for a single key.
func DecryptOne(envName, key string) ([]byte, error) {
	p, err := readParams(envName)
	if err != nil {
		return nil, err
	}
	pass, err := passphrase(envName)
	if err != nil {
		return nil, err
	}
	encKey, macKey, err := deriveKeys(pass, p.salt, p.iter)
	if err != nil {
		return nil, err
	}
	file := filepath.Join(root(), "envs", envName, key+valueExt)
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("no such key: %s", key)
	}
	return decryptEnvelope(string(data), encKey, macKey)
}

