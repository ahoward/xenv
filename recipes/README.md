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

## do you even need a recipe? — `xenv @<env> --json`

If the `xenv` shell tool is present wherever your code runs, you may not
need a recipe at all. Shell out to it and parse the JSON:

```sh
xenv @production --json
# → {"HELLO":"world","DATABASE_URL":"postgres://localhost/demo",...}

xenv --json            # single-env repo: @<env> optional (resolves to the sole env)
```

```python
import json, subprocess
env = json.loads(subprocess.run(
    ["xenv", "@production", "--json"], capture_output=True, text=True, check=True
).stdout)
```

```javascript
const env = JSON.parse(require("child_process").execSync("xenv @production --json"));
```

```go
out, _ := exec.Command("xenv", "@production", "--json").Output()
var env map[string]string
json.Unmarshal(out, &env)
```

```ruby
require "json"
env = JSON.parse(`xenv @production --json`)
```

```java
var p = new ProcessBuilder("xenv", "@production", "--json").start();
var json = new String(p.getInputStream().readAllBytes());   // hand to Jackson/Gson
```

```csharp
var psi = new ProcessStartInfo("xenv", "@production --json") { RedirectStandardOutput = true };
var env = JsonSerializer.Deserialize<Dictionary<string,string>>(Process.Start(psi).StandardOutput.ReadToEnd());
```

```elixir
{out, 0} = System.cmd("xenv", ["@production", "--json"])
env = Jason.decode!(out)
```

```php
$env = json_decode(shell_exec('xenv @production --json'), true);
```

```sh
# shell + jq — no language at all
db=$(xenv @production --json | jq -r .DATABASE_URL)
```

`--json` emits one JSON object `{"KEY":"value",...}`; every value is
byte-exact, control characters use JSON escapes (`\n`, `\t`, `\u00XX`),
and an empty env is `{}`. Any stdlib JSON parser loads it — no envelope
parsing, no crypto dependency, no per-language port.

**When to use which:**

| | needs `xenv` installed | needs a crypto lib | best for |
|---|---|---|---|
| `xenv @<env> --json` | yes | no | dev boxes, CI, containers that ship the tool |
| a recipe (below) | no | yes | production apps that carry only the passphrase + your code |

A recipe is the zero-lock-in path: it reads the on-disk envelopes
directly, so your app needs only the passphrase (via env var) and a
crypto library — not the `xenv` binary. `--json` is the shortcut for
when the tool is already there.

## what xenv is, in one paragraph

xenv stores encrypted environment variables in a project's repo. One file per variable. Each file contains a single line of the form `xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>`. The per-env KDF parameters (`version`, `iter`, `salt`) live in YAML frontmatter at the top of a sibling `README.md`. The passphrase that pairs with those params lives **outside the repo** — for a deployed app, in an environment variable like `$XENV_KEY_PRODUCTION`.

A recipe's job: given an env name, find/read/write `.value.enc` files using the passphrase from the environment, expose three operations (`get`, `set`, `load`) to the calling code.

## on-disk layout

```
<root>/xenv/
├── README.md                              # frontmatter holds project state (recipes can ignore)
└── envs/
    ├── <env_name>/                        # one or more envs (a repo may have just one)
    │   ├── README.md                      # frontmatter holds KDF params (READ THIS)
    │   ├── <KEY1>.value.enc               # one encrypted value per file
    │   ├── <KEY2>.value.enc
    │   └── ...
    └── ...
```

A project may have a **single env** (the common case — `xenv setup` creates
one named `development`) or several (`production`, `staging`, …). A recipe is
always told which env to operate on, so it doesn't care how many exist. The
shell tool has a convenience the recipe contract deliberately omits: if the
repo has exactly one env, `@<env>` is optional (`xenv --json` resolves to the
sole env). Recipes stay explicit — always pass `env_name`.

Recipes find `<root>/xenv/` via `$XENV_ROOT` (default `./xenv/` relative to cwd).
To discover env names, list the subdirectories of `<root>/xenv/envs/`; if there
is exactly one, that is the obvious default to load.

## per-env README frontmatter

```yaml
---
# xenv crypto state — DO NOT EDIT — managed by xenv
# changing these breaks decryption. rotate with: xenv key rotate @<env>
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

## the v4 envelope — self-contained

> **Status: shipped, readable, not the write default.** A conformant reader
> accepts v3, v4, **and** v5. The shell tool no longer writes v4 (v5 is the
> current write default, below); v4 remains fully supported on read.

v3 keeps the KDF `salt` and `iter` in the per-env `README.md` frontmatter.
That couples a value to its directory: copy a lone `.value.enc` somewhere
else, or restore a single variable from git history, and it can no longer be
decrypted on its own. **v4 removes the coupling by embedding the KDF
parameters in the envelope itself**, so one file plus the passphrase is
everything you need — the durable "recover one secret, in any language,
decades later" primitive.

```
xenv:v4:<salt-hex>:<iter>:<iv-hex>:<ct-hex>:<mac-hex>
```

Seven colon-separated fields. Validate:

- `xenv` is literally `xenv`; `v4` is literally `v4`.
- `<salt-hex>` — exactly 32 hex chars (16-byte PBKDF2 salt), **unique per value** (fresh random on every write).
- `<iter>` — PBKDF2 iteration count; matches `^[0-9]+$` (e.g. `200000`). A conformant reader MUST bound it: `1 ≤ iter ≤ 10_000_000`, checked **before** deriving keys. Because v4's `iter` is in the unauthenticated envelope and drives the KDF that produces the MAC key, an unbounded value is a PBKDF2 denial-of-service. Reject out-of-range `iter` without running the KDF.
- `<iv-hex>` — exactly 32 hex chars (16-byte AES IV).
- `<ct-hex>` — a positive multiple of 32 hex chars (CBC block-aligned).
- `<mac-hex>` — exactly 64 hex chars (32-byte HMAC-SHA256).
- Reject any envelope with more or fewer than these seven fields.

### key derivation (v4)

Identical PBKDF2-SHA256 as v3 — but `salt` and `iter` come from **the
envelope**, not the README. The per-env `README.md` frontmatter is **not
consulted** for v4 values.

```
enc-key ‖ mac-key = PBKDF2-SHA256(passphrase, hex_decode(salt-hex), iter, dkLen=64)
first 32 bytes = enc-key,  last 32 bytes = mac-key
```

### MAC scope (v4)

Encrypt-then-MAC over a scope that binds **every** parameter affecting
decryption — version, salt, iterations, IV, ciphertext:

```
MAC = HMAC-SHA256(mac-key, "v4:<salt-hex>:<iter>:<iv-hex>:<ct-hex>")
```

The scope is that literal ASCII string: same field order, same lowercase
hex, `<iter>` in decimal exactly as written in the envelope. Because salt and
iterations feed both the derived key **and** the MAC scope, tampering either
fails verification two ways over. Verify the MAC **before** decrypting, same
as v3.

## the v5 envelope — two-level KDF (current write default)

> **Status: the default the shell tool writes.** A conformant reader accepts
> v3, v4, and v5. New values are v5.

v4 is self-contained but pays a full PBKDF2 **per value** — a `load` over N
variables runs PBKDF2 N times. v5 keeps v4's self-containment while paying
PBKDF2 **once per env**: it derives a per-env master with PBKDF2, then a
cheap per-value key with HKDF. A `load` over 11 values drops from ~2.4s to
~0.8s, and the derived key is still unique per value.

```
xenv:v5:<kdf-salt-hex>:<iter>:<value-salt-hex>:<iv-hex>:<ct-hex>:<mac-hex>
```

Eight colon-separated fields. Validate:

- `xenv` is literally `xenv`; `v5` is literally `v5`.
- `<kdf-salt-hex>` — exactly 32 hex chars (16-byte PBKDF2 salt). Shared by every value in an env (it is the env's README `salt`), which is what lets a loader run PBKDF2 once and reuse the master.
- `<iter>` — PBKDF2 iteration count; `^[0-9]+$`. Same DoS bound as v4: a conformant reader MUST enforce `1 ≤ iter ≤ 10_000_000` **before** running the KDF.
- `<value-salt-hex>` — exactly 32 hex chars (16-byte HKDF salt), **unique per value** (fresh random on every write).
- `<iv-hex>` — exactly 32 hex chars (16-byte AES IV).
- `<ct-hex>` — a positive multiple of 32 hex chars (CBC block-aligned).
- `<mac-hex>` — exactly 64 hex chars (32-byte HMAC-SHA256).
- Reject any envelope with more or fewer than these eight fields.

### key derivation (v5)

Two levels. The master is PBKDF2 over the shared `kdf-salt`; the per-value
key is HKDF-SHA256 (RFC 5869) over that master, keyed by the unique
`value-salt` with a fixed `info`:

```
master             = PBKDF2-SHA256(passphrase, hex_decode(kdf-salt), iter, dkLen=64)
enc-key ‖ mac-key  = HKDF-SHA256(ikm=master, salt=hex_decode(value-salt), info="xenv:v5", L=64)
first 32 bytes = enc-key,  last 32 bytes = mac-key
```

`info` is the literal ASCII string `xenv:v5`. A loader amortizes by
computing `master` once for the env (the `kdf-salt` is constant across its
values) and running only HKDF per value. Any stdlib HKDF-SHA256 interoperates
— the construction is plain RFC 5869 (`PRK = HMAC(salt, ikm)`; `T(1) =
HMAC(PRK, info‖0x01)`; `T(2) = HMAC(PRK, T(1)‖info‖0x02)`; `OKM = T(1)‖T(2)`).

### MAC scope (v5)

Encrypt-then-MAC over every parameter affecting decryption:

```
MAC = HMAC-SHA256(mac-key, "v5:<kdf-salt-hex>:<iter>:<value-salt-hex>:<iv-hex>:<ct-hex>")
```

Literal ASCII, same field order, lowercase hex, `<iter>` in decimal exactly
as written. Verify **before** decrypting, same as v3/v4.

### reading all versions (dual-read)

Dispatch on the second field:

| version | key derivation | salt / iter source | MAC scope |
|---------|----------------|--------------------|-----------|
| `v3`    | PBKDF2 → split | sibling `README.md` frontmatter | `v3:<iv>:<ct>` |
| `v4`    | PBKDF2 → split | the envelope itself             | `v4:<salt>:<iter>:<iv>:<ct>` |
| `v5`    | PBKDF2 → HKDF  | the envelope itself             | `v5:<kdf-salt>:<iter>:<value-salt>:<iv>:<ct>` |

A conformant loader reads all three. Everything else — AES-256-CBC, PKCS#7,
constant-time HMAC compare — is unchanged.

### why per-value salt

- **Isolation.** One file + the passphrase decrypts, with no sibling state to carry along (v4 and v5).
- **Per-value cost bumps.** Raise `<iter>` on new writes as hardware improves; old values keep their own counts and still decrypt — no global re-encryption.
- **Unique salts.** Identical plaintexts under the same passphrase yield unrelated derived keys and envelopes.
- **Speed without giving any of that up (v5).** The shared `kdf-salt` amortizes PBKDF2 across an env; the unique per-value HKDF salt keeps every value's key distinct.

Test vectors for v3, v4, and v5 live in [`recipes/vectors/`](vectors/) —
`vectors.json` plus `verify.rb`/`verify.js` are a language-neutral
conformance oracle. Port the ~20 lines of decrypt and run it against the
JSON to prove a loader is correct.

## passphrase resolution

A recipe reads the passphrase from environment variables, in this order:

1. `$XENV_KEY_<ENV>` — where `<ENV>` is the uppercased env name with `-` replaced by `_`. For env `production`, look for `$XENV_KEY_PRODUCTION`.
2. `$XENV_KEY` — global fallback.

If neither is set, raise / return an error that names the env vars it tried. **Do not** attempt to read files, contact a keychain, or fall back silently — that's the xenv shell tool's job. A recipe is for the app at runtime; the passphrase comes from the platform's secret manager via env var.

## what the recipe exposes

Three operations, idiomatic to the target language:

1. **`get(env_name, key)`** — decrypt and return the plaintext bytes for one key. Errors on missing key, missing passphrase, MAC failure, malformed envelope.

2. **`set(env_name, key, plaintext)`** — encrypt the plaintext and atomically write to `<root>/xenv/envs/<env_name>/<key>.value.enc`. The recipes write the v3 envelope for maximum compatibility, reusing the env's `salt` and `iter` from its `README.md` frontmatter with a fresh IV. (Reading is what must be exhaustive — a recipe reads v3/v4/v5; the shell tool writes v5.) If the env directory or its README doesn't exist, error.

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

### conformance vectors (offline, tool-free)

`recipes/vectors/` is the durable half of the gate: a self-contained
oracle (`vectors.json`) plus two reference verifiers (`verify.rb`,
`verify.js`). Given only that JSON — no `xenv` binary, no vault, no
network — any implementation can prove its decrypt path byte-exact and
its tamper-rejection correct. Port ~20 lines of crypto, run it against
`vectors.json`, done. This is what lets an agent generate a loader and
check its own work with no human in the loop. See
[`recipes/vectors/README.md`](vectors/README.md).

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
- [`ruby/xenv.rb`](ruby/xenv.rb) — pure stdlib `openssl`, zero gems
- [`go/xenv/xenv.go`](go/xenv/xenv.go) + [`go/main/main.go`](go/main/main.go) — stdlib + `golang.org/x/crypto/pbkdf2`
- [`rust/src/lib.rs`](rust/src/lib.rs) — RustCrypto crates: `aes`, `cbc`, `hmac`, `sha2`, `pbkdf2`
- [`elixir/xenv.exs`](elixir/xenv.exs) — pure OTP `:crypto`, zero deps (manual PKCS#7 over raw CBC)
- [`java/Xenv.java`](java/Xenv.java) — JDK `javax.crypto`, no jars; single-file source launch, hand-rolled PBKDF2 over `Mac`
- [`csharp/Program.cs`](csharp/Program.cs) — BCL `System.Security.Cryptography`, no NuGet
- [`gemini/`](gemini/) — proof recipe: built by Google's Gemini model against this README (see `gemini/README.md` for the experiment notes)

## the canonical implementation

If anything in this spec is ambiguous, the xenv shell tool's three functions are the tiebreaker:

- [`derive_keys`](../bin/xenv) — KDF
- [`encrypt_value`](../bin/xenv) — write side
- [`decrypt_value`](../bin/xenv) — read side

You shouldn't need them. This README is intended to be sufficient.
