# building an xenv loader

You are writing a *loader* for the [xenv](https://github.com/ahoward/xenv) encrypted-environment-variable format. Feed this document to a coding agent in any language; the agent should produce a working loader without needing to read the `bin/xenv` shell script.

This file is the spec. The loaders checked in alongside it (`loaders/go/`, `loaders/node/`, `loaders/pythong/`, `loaders/rust/`) were generated from this prompt and should be treated as reference implementations — not as additional spec.

## what xenv is, in one paragraph

xenv stores encrypted environment variables in a project's repo. One file per variable. Each file contains a single line of the form `xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>`. The per-env KDF parameters (`version`, `iter`, `salt`) live in YAML frontmatter at the top of a sibling README. The passphrase that pairs with those params lives **outside the repo** — for a deployed app, in an environment variable like `$XENV_KEY_PRODUCTION`.

A loader's job: given an env name (e.g. `production`), find all the `.value.enc` files, derive keys from the passphrase, verify MAC, decrypt, and hand the resulting `{KEY: value}` map back to the calling code.

## on-disk layout

```
<root>/xenv/
├── README.md                              # frontmatter holds project state (not needed by loaders)
└── envs/
    └── <env_name>/
        ├── README.md                      # frontmatter holds KDF params (READ THIS)
        ├── <KEY1>.value.enc               # one encrypted value per file
        ├── <KEY2>.value.enc
        └── ...
```

Loaders need to find `<root>/xenv/`. The convention: take the env var `$XENV_ROOT` if set, else look for `./xenv/` relative to the current working directory.

## per-env README frontmatter

```yaml
---
# xenv crypto state — DO NOT EDIT — managed by xenv
# changing these breaks decryption. rotate with: xenv rotate <env>
version: v3
iter: 200000
salt: a449a01266a1adf926a541ecd72dd2c2
---

# xenv/<env_name>
...
```

Parse rules (deliberately naive):
- Frontmatter is the block between the first `---` line and the next `---` line.
- Lines starting with `#` (after stripping leading whitespace) are comments — skip.
- Blank lines — skip.
- For every other line, split on the **first** `:`. The key is the trim of the left side; the value is the trim of the right side.
- Keys you care about: `version`, `iter`, `salt`. Ignore unknown keys.

`version` must be `v3` — refuse to decrypt anything else. `iter` is the PBKDF2 iteration count. `salt` is 32 hex characters (16 bytes).

## the value envelope

Each `*.value.enc` file is a single line of ASCII:

```
xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>
```

Fields are colon-separated. Validate:
- `xenv` is literally `xenv` and `v3` is literally `v3` — refuse anything else
- `<iv-hex>` is exactly 32 hex characters (16-byte IV)
- `<ct-hex>` is a positive multiple of 32 hex characters (CBC block-aligned)
- `<mac-hex>` is exactly 64 hex characters (32-byte HMAC-SHA256)
- the envelope has no fields beyond these — reject "extra fields"

## key derivation

```
KDF      PBKDF2-SHA256
input    <passphrase> (UTF-8 bytes), <salt> (16 bytes), <iter> (integer)
output   64 bytes
split    first 32 bytes  = encryption key
         last  32 bytes  = MAC key
```

The encryption key and MAC key are two halves of one PBKDF2 output. One passphrase, two keys, no reuse.

## MAC verification

The MAC scope is the literal ASCII string:

```
v3:<iv-hex>:<ct-hex>
```

— with the colons, with `v3` literally, with the same hex case as the envelope. Compute `HMAC-SHA256(mac_key, mac_scope)` and compare against the envelope's `<mac-hex>` field.

**Verify the MAC BEFORE decrypting.** This is encrypt-then-MAC discipline. Rejecting on MAC failure protects against padding-oracle attacks. Use a constant-time comparison if your language provides one (Python: `hmac.compare_digest`; Node: `crypto.timingSafeEqual`; Go: `hmac.Equal`).

## decryption

```
cipher   AES-256-CBC
key      32 bytes (the encryption key from above)
iv       16 bytes (hex-decoded from the envelope)
input    hex-decoded <ct-hex>
output   plaintext bytes (PKCS#7 padding is applied/stripped by the cipher)
```

Treat the plaintext as bytes, not as a string. Some values are PEM keys, JSON blobs, or binary. Only convert to a string at the boundary if your language insists.

## passphrase resolution

A loader reads the passphrase from environment variables, in this order:

1. `$XENV_KEY_<ENV>` — where `<ENV>` is the uppercased env name with `-` replaced by `_`. For env `production`, look for `$XENV_KEY_PRODUCTION`.
2. `$XENV_KEY` — global fallback.

If neither is set, the loader should raise / return an error that names the env vars it tried. Do **not** attempt to read files, contact a keychain, or fall back silently — that's the xenv shell tool's job. A loader is for production deployments where the passphrase is injected by the platform's secret manager.

## what the loader exposes

The loader should expose two operations, idiomatic to its language:

1. **`load(env_name)`** — returns a `{KEY: plaintext}` map of every variable in the named env. Reads all `*.value.enc` files in `<root>/xenv/envs/<env_name>/` (excluding the README), decrypts each, returns the dict. Raises / returns an error if anything fails.

2. **`decrypt_one(env_name, key)`** — returns the plaintext for a single key. Faster than `load()` when you only need one value.

Both should also be exposable via a CLI, so the shared `loaders/test.sh` rig can drive each loader uniformly:

```
<runtime> <loader> <env_name> <key>     → prints plaintext of one key to stdout
<runtime> <loader> <env_name>           → prints "KEY=value" pairs, one per line
```

(Pick a sensible convention if `<key>` contains `=`. The xenv shell tool stores values as file *contents*, so a value can contain `=`, newlines, anything. The KEY portion of the filename never can.)

## what NOT to do

- Don't reimplement the xenv shell tool's full API. No `set`, no `rotate`, no `init`. A loader is read-only.
- Don't add file-based / keychain / `pass` passphrase resolution. Production apps use env vars.
- Don't validate variable names, env names, or plaintext values. They're bytes.
- Don't add config-file support, plugin systems, or a CLI flag parser beyond the minimum needed for the test rig.
- Don't ship a `package.json` / `go.mod` / `pyproject.toml` unless the language genuinely requires one to run.
- Don't introduce dependencies beyond what the language's standard library lacks for AES-CBC + HMAC + PBKDF2. If you need one well-known dep (e.g. `golang.org/x/crypto/pbkdf2` for Go), use it; otherwise stay stdlib.

## verification

The loader is correct if, given an `xenv/` tree created by `xenv init` + some `xenv set ENV KEY=value` calls, and given `$XENV_KEY_<ENV>` set to the same passphrase that's at `~/.config/xenv/projects/<id>/keys/<env>`, the loader:

1. `load(env)` returns a dict containing every key set, with the exact plaintext for each
2. `decrypt_one(env, KEY)` returns the same plaintext as `load(env)[KEY]`
3. on a tampered `.value.enc` (any byte changed), MAC verification fails before decrypt and the loader raises

The `loaders/test.sh` script exercises all three properties against every checked-in loader. Run it before sending a PR that touches anything in `loaders/`.

## reference: the canonical implementation

The xenv shell tool itself uses three small functions for all the crypto:

- `derive_keys` in [`bin/xenv`](../bin/xenv) — KDF
- `encrypt_value` in [`bin/xenv`](../bin/xenv) — write side (loaders don't need this)
- `decrypt_value` in [`bin/xenv`](../bin/xenv) — read side (loaders mirror this)

If anything in this spec is ambiguous, those functions are the tiebreaker.
