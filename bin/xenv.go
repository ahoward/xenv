// xenv — a git-backed secrets vault. Encrypted, per-key, commit-safe
// environment variables. This is the canonical Go source; it is embedded
// verbatim inside the polyglot POSIX bootstrap `bin/xenv`, which compiles
// and caches it on first run (see that file's header).
//
// Pure stdlib — no external modules — so `go build` works on a lone file
// with no go.mod and no network. PBKDF2 and HKDF are hand-rolled from
// crypto/hmac + crypto/sha256 (a dozen lines each), so the whole tool,
// crypto included, is auditable in one sitting.
//
// Wire format is unchanged from the POSIX implementation and frozen; the
// conformance vectors in recipes/vectors/ and the nine language recipes
// keep every implementation honest.
package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

const xenvVersion = "0.17.0-posix"

// ── KDF primitives (hand-rolled, pure stdlib) ─────────────────────────

// pbkdf2SHA256 is PBKDF2-HMAC-SHA256 (RFC 2898). Byte-for-byte identical to
// golang.org/x/crypto/pbkdf2 and openssl's `kdf ... PBKDF2`.
func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	hashLen := prf.Size()
	numBlocks := (keyLen + hashLen - 1) / hashLen

	var buf [4]byte
	dk := make([]byte, 0, numBlocks*hashLen)
	u := make([]byte, hashLen)
	for block := 1; block <= numBlocks; block++ {
		prf.Reset()
		prf.Write(salt)
		buf[0] = byte(block >> 24)
		buf[1] = byte(block >> 16)
		buf[2] = byte(block >> 8)
		buf[3] = byte(block)
		prf.Write(buf[:4])
		dk = prf.Sum(dk)
		t := dk[len(dk)-hashLen:]
		copy(u, t)
		for n := 2; n <= iter; n++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for x := range u {
				t[x] ^= u[x]
			}
		}
	}
	return dk[:keyLen]
}

// hkdfSHA256 is HKDF (RFC 5869) extract-then-expand with SHA-256. Matches
// golang.org/x/crypto/hkdf, openssl, and the shell tool's manual HMAC form.
func hkdfSHA256(ikm, salt, info []byte, length int) []byte {
	extract := hmac.New(sha256.New, salt)
	extract.Write(ikm)
	prk := extract.Sum(nil)

	var out, t []byte
	for counter := byte(1); len(out) < length; counter++ {
		h := hmac.New(sha256.New, prk)
		h.Write(t)
		h.Write(info)
		h.Write([]byte{counter})
		t = h.Sum(nil)
		out = append(out, t...)
	}
	return out[:length]
}

// pbkdf2Okm returns the raw 64-byte PBKDF2 output (the env "master").
func pbkdf2Okm(pass, saltHex string, iter int) ([]byte, error) {
	salt, err := hex.DecodeString(saltHex)
	if err != nil {
		return nil, err
	}
	return pbkdf2SHA256([]byte(pass), salt, iter, 64), nil
}

// ── envelope (v3/v4/v5) ───────────────────────────────────────────────

const hkdfInfoV5 = "xenv:v5"

// decryptEnvelope dual-reads v3/v4/v5. The caller precomputes envOkm =
// PBKDF2 over the env README salt/iter ONCE; per value it is a slice (v3),
// a per-value PBKDF2 (v4), or a cheap HKDF over the shared master (v5).
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
		macScope = "v3:" + ivHex + ":" + ctHex
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
		macScope = "v4:" + saltHex + ":" + iterStr + ":" + ivHex + ":" + ctHex
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
		okm := hkdfSHA256(ikm, vs, []byte(hkdfInfoV5), 64)
		encKey, macKey = okm[:32], okm[32:]
		macScope = "v5:" + kdfSalt + ":" + iterStr + ":" + valueSalt + ":" + ivHex + ":" + ctHex
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

	// MAC verify FIRST (encrypt-then-MAC; constant-time compare).
	h := hmac.New(sha256.New, macKey)
	h.Write([]byte(macScope))
	if subtle.ConstantTimeCompare(h.Sum(nil), providedMac) != 1 {
		return nil, errors.New("MAC verification failed — wrong key or tampered vault")
	}

	block, err := aes.NewCipher(encKey)
	if err != nil {
		return nil, err
	}
	if len(ct)%block.BlockSize() != 0 {
		return nil, errors.New("envelope: ciphertext not block-aligned")
	}
	plain := make([]byte, len(ct))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, ct)

	// strip PKCS#7 padding
	if len(plain) == 0 {
		return nil, errors.New("envelope: empty plaintext")
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

// encryptV5 encrypts plaintext into a v5 envelope. kdfSalt/iter come from
// the env README (the shared master); a fresh per-value salt gives each
// value its own HKDF-derived keys. Caller passes the precomputed master.
func encryptV5(plaintext, master []byte, kdfSalt string, iter int) (string, error) {
	valueSalt := make([]byte, 16)
	if _, err := rand.Read(valueSalt); err != nil {
		return "", err
	}
	okm := hkdfSHA256(master, valueSalt, []byte(hkdfInfoV5), 64)
	encKey, macKey := okm[:32], okm[32:]

	block, err := aes.NewCipher(encKey)
	if err != nil {
		return "", err
	}
	iv := make([]byte, block.BlockSize())
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	bs := block.BlockSize()
	pad := bs - (len(plaintext) % bs)
	padded := make([]byte, len(plaintext)+pad)
	copy(padded, plaintext)
	for i := len(plaintext); i < len(padded); i++ {
		padded[i] = byte(pad)
	}
	ct := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ct, padded)

	ivHex := hex.EncodeToString(iv)
	ctHex := hex.EncodeToString(ct)
	valueSaltHex := hex.EncodeToString(valueSalt)
	iterStr := strconv.Itoa(iter)
	macScope := "v5:" + kdfSalt + ":" + iterStr + ":" + valueSaltHex + ":" + ivHex + ":" + ctHex
	h := hmac.New(sha256.New, macKey)
	h.Write([]byte(macScope))
	macHex := hex.EncodeToString(h.Sum(nil))

	return fmt.Sprintf("xenv:v5:%s:%s:%s:%s:%s:%s", kdfSalt, iterStr, valueSaltHex, ivHex, ctHex, macHex), nil
}

// ── conformance self-test (temporary; validates crypto vs vectors) ────

type vectorFile struct {
	Passphrase string `json:"passphrase"`
	Vectors    []struct {
		Name         string `json:"name"`
		Wire         string `json:"wire"`
		Expect       string `json:"expect"`
		Salt         string `json:"salt"`
		Iter         int    `json:"iter"`
		Envelope     string `json:"envelope"`
		PlaintextB64 string `json:"plaintext_b64"`
	} `json:"vectors"`
}

func runConformance(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	var vf vectorFile
	if err := json.Unmarshal(data, &vf); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fails := 0
	for _, v := range vf.Vectors {
		// caller-side env master (v3 uses it; v4/v5 self-contained). Only
		// derive when iter is sane — some vectors carry a hostile iter to
		// exercise the in-envelope DoS bound, and the real tool derives
		// envOkm from the trusted README iter, never the envelope's.
		var envOkm []byte
		if v.Iter >= 1 && v.Iter <= 10_000_000 {
			envOkm, _ = pbkdf2Okm(vf.Passphrase, v.Salt, v.Iter)
		}
		got, derr := decryptEnvelope(v.Envelope, vf.Passphrase, v.Salt, v.Iter, envOkm)
		label := fmt.Sprintf("%s (%s %s)", v.Name, v.Wire, v.Expect)
		if v.Expect == "ok" {
			if derr != nil {
				fmt.Printf("  FAIL  %s: %v\n", label, derr)
				fails++
				continue
			}
			want, _ := b64decode(v.PlaintextB64)
			if string(got) != string(want) {
				fmt.Printf("  FAIL  %s: plaintext mismatch\n", label)
				fails++
				continue
			}
			fmt.Printf("  ok    %s\n", label)
		} else {
			if derr == nil {
				fmt.Printf("  FAIL  %s: expected %s but decrypt SUCCEEDED\n", label, v.Expect)
				fails++
				continue
			}
			fmt.Printf("  ok    %s: rejected (%v)\n", label, derr)
		}
	}
	if fails == 0 {
		fmt.Println("\nALL VECTORS PASS")
		return 0
	}
	fmt.Printf("\n%d FAILED\n", fails)
	return 1
}

func b64decode(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

func main() {
	args := os.Args[1:]
	if len(args) == 2 && args[0] == "__conformance" {
		os.Exit(runConformance(args[1]))
	}
	if len(args) == 1 && (args[0] == "version" || args[0] == "--version" || args[0] == "-v") {
		fmt.Printf("xenv %s\n", xenvVersion)
		return
	}
	fmt.Fprintln(os.Stderr, "xenv: verb surface not yet ported (foundation build)")
	os.Exit(2)
}
