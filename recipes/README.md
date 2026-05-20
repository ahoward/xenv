# recipes

## NAME

recipes — regenerative xenv implementations. one prompt, N languages, all built from this README.

## TL;DR;

🤖 Feed this README to any coding agent. It produces a minimal-but-complete xenv implementation in the target language. Read encrypted env vars, write new ones, load a whole env into your app. Everything you need to *use* xenv; nothing you don't.

This directory leans into Chad Fowler's [phoenix architecture](https://www.infoq.com/news/2013/08/immutable-servers/) explicitly: **the prompt is the source of truth, the recipes are reconstructable outputs**. Burn down `recipes/{pythong,node,go,rust}/`; feed this README to an agent; the recipes rise from the ashes. That's the test.

```
recipes/
├── README.md         ← you are here (the prompt + the spec + the demo)
├── build             ← compile/install deps for every recipe
├── try               ← demo-run every recipe against ./xenv with the demo key
├── test              ← rigorous round-trip + tamper assertions
├── xenv/             ← canned demo vault (real envelopes, DEMO ONLY key)
├── pythong/xenv.py
├── node/xenv.js
├── go/{xenv,main}/   ← package + CLI
└── rust/             ← cargo crate + bin
```

## demo

Every recipe round-trips against the same checked-in `recipes/xenv/`. The passphrase is published below — it's deliberately throwaway, **demo only**, and *will not appear in any real xenv project*.

```sh
export XENV_KEY_PRODUCTION='demo-key-for-recipes-NOT-FOR-REAL-USE'
export XENV_ROOT="$(pwd)/recipes/xenv"

recipes/build      # one-time: install deps, compile
recipes/try        # run every recipe; show output of get / load / set
recipes/test       # run rigorous assertions across every recipe
```

Demo vault contents (already encrypted in `recipes/xenv/envs/production/`):

| key            | plaintext                       |
|----------------|---------------------------------|
| `HELLO`        | `world`                         |
| `DATABASE_URL` | `postgres://localhost/demo`     |
| `GREETING`     | `hi from xenv recipes`          |
| `APP_ENV`      | `production`                    |

## what xenv is, in one paragraph

xenv stores encrypted environment variables in a project's repo. One file per variable. Each file contains a single line of the form `xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>`. The per-env KDF parameters (`version`, `iter`, `salt`) live in YAML frontmatter at the top of a sibling `README.md`. The passphrase that pairs with those params lives **outside the repo** — for a deployed app, in an environment variable like `$XENV_KEY_PRODUCTION`.

A recipe's job: given an env name, find/read/write `.value.enc` files using the passphrase from the environment, expose three operations (`get`, `set`, `load`) to the calling code.

## on-disk layout

```
<root>/xenv/
├── README.md                              # frontmatter holds project state (recipes can ignore)
└── envs/
    └── <env_name>/
        ├── README.md                      # frontmatter holds KDF params (READ THIS)
        ├── <KEY1>.value.enc               # one encrypted value per file
        ├── <KEY2>.value.enc
        └── ...
```

Recipes find `<root>/xenv/` via `$XENV_ROOT` (default `./xenv/` relative to cwd).

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
- For every other line, split on the **first** `:`. Key is the trim of the left side; value is the trim of the right side.
- Keys you care about: `version`, `iter`, `salt`. Ignore unknown keys.

`version` must be `v3` — refuse anything else. `iter` is the PBKDF2 iteration count (positive integer, typically 200000). `salt` is 32 hex characters (16 bytes).

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

One passphrase, two keys, no reuse.

## decryption (the read side)

```
1. Parse envelope:  split on `:` → tag, version, iv-hex, ct-hex, mac-hex
2. Validate fields:  refuse if any check above fails
3. Derive keys:      PBKDF2-SHA256(passphrase, salt, iter) → enc-key || mac-key
4. Verify MAC:       HMAC-SHA256(mac_key, "v3:<iv-hex>:<ct-hex>") == mac-hex
                     ↑ constant-time compare; refuse on mismatch BEFORE step 5
5. Decrypt:          AES-256-CBC, key=enc-key, iv=hex_decode(iv-hex),
                     ct=hex_decode(ct-hex). PKCS#7 padding.
```

The MAC scope is the literal ASCII string `"v3:<iv-hex>:<ct-hex>"` — with the colons, with `v3` literally, with the same hex case as the envelope. Use a constant-time comparison if your language provides one (`hmac.compare_digest` in Python, `crypto.timingSafeEqual` in Node, `hmac.Equal` in Go, `Hmac::verify_slice` in RustCrypto).

**Verify MAC before decrypting.** Encrypt-then-MAC discipline; protects against padding-oracle attacks.

## encryption (the write side)

```
1. Derive keys:      same as decryption (PBKDF2-SHA256 → 64 bytes → split)
2. Random IV:        16 fresh random bytes (a new IV per encrypt — never reuse)
3. Encrypt:          AES-256-CBC, key=enc-key, iv=iv. PKCS#7 padding.
4. Compute MAC:      HMAC-SHA256(mac_key, "v3:<iv-hex>:<ct-hex>")
5. Assemble:         "xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>\n"
6. Atomic write:     write to <KEY>.value.enc.tmp, then rename to <KEY>.value.enc
```

Use a CSPRNG for the IV (`os.urandom` in Python, `crypto.randomBytes` in Node, `crypto/rand` in Go, `OsRng` in Rust).

Atomicity matters: write the new envelope to a temp file, then `rename(2)` it into place. POSIX rename is atomic on the same filesystem. Don't write to the destination file directly — a crash mid-write would corrupt the value.

## passphrase resolution

A recipe reads the passphrase from environment variables, in this order:

1. `$XENV_KEY_<ENV>` — where `<ENV>` is the uppercased env name with `-` replaced by `_`. For env `production`, look for `$XENV_KEY_PRODUCTION`.
2. `$XENV_KEY` — global fallback.

If neither is set, raise / return an error that names the env vars it tried. **Do not** attempt to read files, contact a keychain, or fall back silently — that's the xenv shell tool's job. A recipe is for the app at runtime; the passphrase comes from the platform's secret manager via env var.

## what the recipe exposes

Three operations, idiomatic to the target language:

1. **`get(env_name, key)`** — decrypt and return the plaintext bytes for one key. Errors on missing key, missing passphrase, MAC failure, malformed envelope.

2. **`set(env_name, key, plaintext)`** — encrypt the plaintext and atomically write to `<root>/xenv/envs/<env_name>/<key>.value.enc`. Reuses the existing env's `salt` and `iter` from the env's `README.md` frontmatter; only a fresh IV is generated. If the env directory or its README doesn't exist, error.

3. **`load(env_name)`** — return a `{KEY: plaintext}` map of every variable in the named env. Read all `*.value.enc` files (excluding the README), decrypt each, return the map.

Each recipe also exposes a CLI mode, so `recipes/try` and `recipes/test` can drive every recipe uniformly:

```
<runtime> <recipe> get  <env> <key>            → plaintext to stdout
<runtime> <recipe> set  <env> <key> <value>    → writes encrypted value, exits 0
<runtime> <recipe> load <env>                  → prints "KEY=value" lines
```

## what NOT to do

- **Don't reimplement the shell tool.** No `rotate`, no `init`, no `edit`, no `keygen`, no `unset`. Recipes are minimal-but-complete: `get`, `set`, `load`. That's it.
- **Don't add file-based / keychain / `pass` passphrase resolution.** Production apps use env vars.
- **Don't validate variable names, env names, or values.** They're bytes. The shell tool stores values as file contents; the only restriction is that the KEY portion of a filename can't contain `/`.
- **Don't add config-file support, plugin systems, flag parsing.** Beyond the minimum needed for the CLI.
- **Don't introduce dependencies beyond stdlib + one well-known crypto dep where the language lacks PBKDF2/AES/HMAC.** Rust needs RustCrypto; Go needs `golang.org/x/crypto/pbkdf2`; Node's stdlib covers everything; Python's stdlib has `hashlib.pbkdf2_hmac` + `hmac` but no AES (shell out to `openssl(1)` is acceptable, or use the `cryptography` package if your project already depends on it).

## verification

A recipe is correct if, given the checked-in `recipes/xenv/` and `$XENV_KEY_PRODUCTION='demo-key-for-recipes-NOT-FOR-REAL-USE'`:

1. `get production HELLO` prints `world` (exact bytes)
2. `get production DATABASE_URL` prints `postgres://localhost/demo`
3. `load production` returns every key in the demo vault
4. `set production NEWKEY=newvalue` writes a new `.value.enc` that `xenv get` (the canonical shell tool) can decrypt back to `newvalue`
5. On a tampered envelope (any byte flipped), `get` errors with a MAC-failure message rather than returning garbage

`recipes/test` runs all five assertions against every recipe. `recipes/try` does a friendlier demo run.

## scripts

`recipes/build`

> Build every recipe in the repo. Pre-compiles Rust (release), prefetches Go deps, etc. Idempotent. Skips a recipe if its toolchain isn't installed.

`recipes/try`

> Demo-run every recipe against `recipes/xenv/`. Prints what `get HELLO`, `get DATABASE_URL`, and `load production` return for each. Visual proof that the recipes work.

`recipes/test`

> The rigorous version. Asserts plaintexts match, asserts tampered envelopes are rejected, asserts the write side round-trips. Exits non-zero on any failure. CI runs this.

## reference recipes

The recipes checked in here were generated from earlier versions of this README. Each is independent — read any one for inspiration; the prompt is the canonical spec.

- [`pythong/xenv.py`](pythong/xenv.py) — stdlib `hashlib` + `hmac`; shells out to `openssl(1)` for AES (Python's stdlib has no AES)
- [`node/xenv.js`](node/xenv.js) — pure stdlib `crypto`, zero deps
- [`go/xenv/xenv.go`](go/xenv/xenv.go) + [`go/main/main.go`](go/main/main.go) — stdlib + `golang.org/x/crypto/pbkdf2`
- [`rust/src/lib.rs`](rust/src/lib.rs) — RustCrypto crates: `aes`, `cbc`, `hmac`, `sha2`, `pbkdf2`
- [`gemini/`](gemini/) — proof recipe: built by Google's Gemini model against this README (see `gemini/README.md` for the experiment notes)

## the canonical implementation

If anything in this spec is ambiguous, the xenv shell tool's three functions are the tiebreaker:

- [`derive_keys`](../bin/xenv) — KDF
- [`encrypt_value`](../bin/xenv) — write side
- [`decrypt_value`](../bin/xenv) — read side

You shouldn't need them. This README is intended to be sufficient.
