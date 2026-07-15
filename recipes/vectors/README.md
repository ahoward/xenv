# xenv conformance test vectors

Official, versioned **decrypt conformance vectors**. This directory is a
self-contained oracle: given only `vectors.json`, any implementation can
prove its decrypt path is correct — **no `xenv` binary, no vault on disk,
no network.**

This is the durable core of xenv's multi-language story. The wire format is
the spec; these vectors are the proof. Port ~20 lines of crypto to your
language, run it against `vectors.json`, and if every vector passes your
loader interoperates with every other implementation, forever.

## ⚠️ DEMO ONLY

The passphrase in `vectors.json` (`demo-key-for-recipes-NOT-FOR-REAL-USE`)
is deliberately throwaway. It exists so the vectors are self-verifying. It
**never** appears in a real xenv project.

## What's inside

- **`vectors.json`** — the oracle. Top-level fields document the crypto;
  `vectors[]` is the test set.
- **`verify.rb`**, **`verify.js`** — two independent reference verifiers, in
  different languages, that both pass against the same JSON. They *are* the
  minimal read-only loader: `(passphrase, salt, iter, envelope) → plaintext`.

## `vectors.json` schema

```jsonc
{
  "passphrase": "…",                 // demo passphrase for every vector
  "kdf":    "pbkdf2-sha256",
  "cipher": "aes-256-cbc",
  "mac":    "hmac-sha256; encrypt-then-MAC; scope = \"<ver>:<iv-hex>:<ct-hex>\"",
  "plaintext_encoding": "plaintext_b64 is base64 of the exact decrypted bytes",
  "vectors": [
    {
      "name": "hello",
      "wire": "v3",
      "env":  "production",
      "key":  "HELLO",
      "iter": 200000,
      "salt": "…32 hex…",
      "envelope": "xenv:v3:<iv>:<ct>:<mac>",
      "plaintext_b64": "d29ybGQ=",     // present when expect == "ok"
      "expect": "ok"                    // "ok" | "mac_fail"
    }
  ]
}
```

Coverage: both wire versions. **v3** (KDF salt/iter in the README frontmatter)
and **v4** (self-contained — salt/iter embedded in the envelope), each with a
basic value, an **empty** value, a **multi-line** value, a **unicode** value,
plus a **tampered** envelope per version (`expect: "mac_fail"`) that MUST be
rejected rather than decrypted to garbage. A conformant reader dispatches on
the version field and passes all of them.

For a `v3` vector the verifier takes `salt`/`iter` from the vector (the
frontmatter model); for a `v4` vector it ignores them and reads salt/iter from
the envelope itself — proving the v4 envelope is truly self-contained.

## How to self-verify a loader

Your loader passes conformance iff, for every vector:

- **`expect: "ok"`** → derive keys from `passphrase` + `salt` + `iter`
  (PBKDF2-SHA256, 64 bytes → 32 enc ‖ 32 mac), verify the HMAC over the scope
  `"<ver>:<iv-hex>:<ct-hex>"` (constant-time), AES-256-CBC-decrypt, strip
  PKCS#7 — and the result equals `base64_decode(plaintext_b64)` **byte for
  byte**.
- **`expect: "mac_fail"`** → the same routine **raises/errors** (MAC verify
  fails). It must never return a plaintext.

Run the references:

```sh
ruby verify.rb      # → ALL VECTORS PASS
node verify.js      # → ALL VECTORS PASS
```

Each reference is ~40 lines total and ~20 lines of actual crypto. Copy one,
translate it to your language, point it at `vectors.json`. That is the entire
conformance contract — and it is exactly what an LLM needs to generate a
correct loader and check its own work with no human in the loop.

## Relationship to the tool

The tool (`bin/xenv`) is the sole **writer**; loaders are **readers**. The
CI gate is: *the tool writes → every loader reads it back byte-exact and
rejects tampering.* These vectors are the frozen, offline half of that gate —
the part that survives even if the tool disappears.
