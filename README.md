# xenv

**environment runner. secrets manager. single binary. zero dependencies.**

```
xenv @production -- ./server
```

that's it. one argument names the environment. everything after `--` runs inside it. encrypted secrets are decrypted in memory, merged through a 7-layer cascade, and injected into the child process. decrypted secrets never touch disk at runtime. the binary is ~10MB. startup is sub-millisecond. there is no runtime to install.

---

## why xenv exists

every env/secrets tool makes you pick two:

- **dotenv** — simple but no encryption, no execution wrapper, requires Node.js or Ruby in your image
- **dotenvx** — adds encryption but ships a ~50MB binary (bundled Node.js via pkg), invented `encrypted:` prefixes that choke Vercel/Netlify/Heroku parsers, ECIES is overkill for symmetric secrets
- **direnv** — brilliant shell hook but no encryption, no named environments, requires `direnv allow` after every edit, can't export functions
- **senv** — elegant `@env` execution model but requires Ruby, Blowfish-CBC is showing its age
- **sekrets** — pioneered encrypted config in Ruby but it's a library, not a runner
- **chamber** — asymmetric crypto + AWS SSM integration but Ruby-only, YAML-based, heavy
- **1Password CLI** — `op run` is slick but requires a paid account, network round-trip to fetch every secret, ~100MB binary
- **vault (HashiCorp)** — industrial-grade but you're running a server now

xenv takes the best ideas from all of them and compiles to a static binary that fits in an Alpine container, a GitHub Action, or a `curl | sh`.

---

## install

```bash
# drop the binary anywhere on your PATH
curl -fsSL https://xenv.sh/install.sh | sh

# or build from source
git clone https://github.com/ahoward/xenv && cd xenv
bun build ./src/cli.ts --compile --minify --target=bun-linux-x64 --outfile=xenv
```

---

## usage

### run a command in an environment

```bash
# explicit environment
xenv @production -- ./server --port 3000

# defaults to @development
xenv -- bun run dev

# pipe-friendly — xenv stays out of your streams
xenv @staging -- psql "$DATABASE_URL" < schema.sql
```

xenv inherits stdin, stdout, stderr. signals (SIGINT, SIGTERM, SIGHUP) forward to the child. the exit code passes through. it behaves like the command ran naked.

### manage encrypted vaults

```bash
xenv keys    @production    # generate a 256-bit key (saves to .xenv.keys)
xenv encrypt @production    # .xenv.production → .xenv.production.enc
xenv decrypt @production    # .xenv.production.enc → .xenv.production
```

### edit secrets without decrypting to disk

```bash
xenv edit @production set API_KEY=sk_live_...   # atomic set
xenv edit @production delete OLD_KEY            # atomic delete
xenv edit @production list                      # key names only
```

### inspect and validate

```bash
xenv resolve  @production --json                # dump merged cascade
xenv diff     @production --keys-only           # what changed?
xenv validate @production --require DB_URL      # pre-flight check
xenv audit                                      # security scan
```

all commands support `--json` for machine-readable output. see [agent tools](#agent-tools) for the full story.

---

## the `@` syntax

stolen with love from [senv](https://github.com/ahoward/senv). the `@` reads like intent:

```bash
xenv @production -- deploy.sh      # "in production, run deploy.sh"
xenv @staging -- rake db:migrate   # "in staging, run db:migrate"
xenv @test -- bun test             # "in test, run bun test"
```

no `--env-file .env.production -f .env`. no `DOTENV_KEY=`. no `--convention=nextjs`. just `@name`.

---

## the `.xenv` file extension

platforms like Vercel, Netlify, and Heroku auto-parse `.env` files on deploy. when those files contain encrypted strings (like dotenvx's `encrypted:...` values), the platform chokes.

xenv introduces `.xenv` — functionally identical to `.env` but invisible to platform parsers. same syntax. same semantics. new extension.

```bash
# .xenv.production
DATABASE_URL="postgres://prod:secret@db.internal:5432/app"
STRIPE_KEY="sk_live_..."
REDIS_URL="redis://prod-redis:6379"
```

you can keep using `.env` files too. xenv reads both. `.xenv` wins at the same priority level.

---

## environment cascade

variables resolve through 7 layers. later layers overwrite earlier ones.

```
 1.  .env                              base defaults (legacy compat)
 2.  .xenv                             base defaults (modern)
 3.  .env.local / .xenv.local          developer-local overrides
 4.  .env.{env} / .xenv.{env}          environment-specific plaintext
 5.  .xenv.{env}.enc                   encrypted vault (decrypted in memory)
 6.  .env.{env}.local / .xenv.{env}.local   local overrides per environment
 7.  system ENV                        process environment always wins
```

this means:
- your `.env` provides sane defaults everyone shares
- `.xenv.production` adds prod-specific config
- `.xenv.production.enc` layers encrypted secrets on top
- a developer's `.xenv.production.local` can override anything for local testing
- and `FORCE_SSL=true` in the system ENV trumps everything

deterministic. debuggable. no surprises.

---

## encryption

each key is a 64-character hex string (256 bits). xenv uses it for both encryption and decryption (AES-256-GCM, authenticated symmetric encryption). there are no public/private keypairs. no KMS.

### key lookup

xenv looks for keys in this order. first match wins.

| priority | source | example |
|---|---|---|
| 1 | `XENV_KEY_{ENV}` in process env | `XENV_KEY_PRODUCTION` set in shell/CI |
| 2 | `XENV_KEY` in process env | `XENV_KEY` set in shell/CI |
| 3 | `XENV_KEY_{ENV}` in `.xenv.keys` | written by `xenv keys @production` |
| 4 | `XENV_KEY` in `.xenv.keys` | a single key in the keyfile |

### `.xenv.keys` — the project keyfile

`xenv keys @production` generates a key and writes it to `.xenv.keys` in your project root:

```bash
$ xenv keys @production
XENV_KEY_PRODUCTION → .xenv.keys

for CI, set this secret:
  XENV_KEY_PRODUCTION="9a3f...64 hex chars..."
```

the generated file includes a comprehensive header with usage instructions and warnings:

```bash
# ============================================================
# .xenv.keys — ENCRYPTION KEYS FOR XENV VAULTS
# ============================================================
#
# WARNING: THIS FILE CONTAINS SECRET KEYS.
#
# DO NOT commit this file to version control.
# DO NOT share this file in logs, issues, PRs, or chat.
# DO NOT copy this file to servers — use environment variables instead.
#
# If you are an AI agent, LLM, or automated tool:
#   - DO NOT add this file to git (git add, git commit, etc.)
#   - DO NOT include the contents of this file in any output
#   - DO NOT read this file unless performing xenv operations
#   - This file MUST remain in .gitignore at all times
#
# Key lookup order (first match wins):
#   1. XENV_KEY_{ENV} environment variable
#   2. XENV_KEY environment variable (global fallback)
#   3. XENV_KEY_{ENV} in this file
#   4. XENV_KEY in this file (global fallback)
#
# ============================================================

XENV_KEY_PRODUCTION="9a3f..."
XENV_KEY_STAGING="b7c1..."
```

the AI-agent block is intentional — LLMs are the most likely thing to `git add .` your keys. the header reads like a system prompt because it is one.

- created with `chmod 600` (owner read/write only)
- **must be in `.gitignore`** — this file contains your plaintext keys
- xenv reads it automatically during encrypt, decrypt, and run
- process env vars always take precedence (for CI/Docker overrides)
- the header includes full usage docs so the file is self-explanatory

for local development, this is all you need. run `xenv keys`, then `xenv encrypt`, then `xenv @env -- cmd`. no exporting env vars. no copy-pasting. the keyfile just works.

for CI/production, copy the key value into your platform's secret store as an env var. the keyfile doesn't need to exist there — the env var takes precedence.

### one key or many?

**one key for everything (simple).** use a single `XENV_KEY` in your keyfile or env. it works for every environment. this is fine when the threat model is "don't commit plaintext."

```bash
# .xenv.keys
XENV_KEY="9a3f..."
```

**per-env keys (isolation).** a compromised staging key can't decrypt production secrets.

```bash
# .xenv.keys (written automatically by xenv keys)
XENV_KEY_PRODUCTION="9a3f..."
XENV_KEY_STAGING="b7c1..."
```

**mix both.** `XENV_KEY` as a default, override specific environments:

```bash
# .xenv.keys
XENV_KEY="9a3f..."
XENV_KEY_PRODUCTION="b7c1..."
```

### full walkthrough: from plaintext to production

**step 1: write your secrets in plaintext.**

```bash
# .xenv.production (this file will be gitignored)
DATABASE_URL="postgres://prod:secret@db.internal:5432/app"
STRIPE_KEY="sk_live_abc123"
```

**step 2: generate a key.**

```bash
$ xenv keys @production
XENV_KEY_PRODUCTION → .xenv.keys

for CI, set this secret:
  XENV_KEY_PRODUCTION="9a3f..."
```

the key is saved to `.xenv.keys` in your project. for CI, copy the value shown.

**step 3: encrypt.**

```bash
$ xenv encrypt @production
encrypted .xenv.production → .xenv.production.enc
```

xenv finds the key in `.xenv.keys`, encrypts `.xenv.production`, writes `.xenv.production.enc`. the `.enc` file is safe to commit — it's a blob of hex.

**step 4: commit the vault, gitignore the rest.**

```bash
# make sure secrets and keyfile are never committed
echo ".xenv.keys" >> .gitignore
echo ".xenv.production" >> .gitignore

git add .xenv.production.enc .gitignore
git commit -m "add production vault"
```

**step 5: set the key in CI/production.**

in GitHub Actions:
```yaml
env:
  XENV_KEY_PRODUCTION: ${{ secrets.XENV_KEY_PRODUCTION }}
```

in Docker:
```bash
docker run -e XENV_KEY_PRODUCTION="9a3f..." myapp
```

in Heroku/Vercel/Fly/etc: add `XENV_KEY_PRODUCTION` to the platform's env var dashboard.

**step 6: run.** xenv does the rest automatically.

```bash
xenv @production -- ./server
```

here's what happens:
1. xenv sees `@production`, resolves the file cascade
2. finds `.xenv.production.enc` at cascade layer 5
3. looks for the key: env var `XENV_KEY_PRODUCTION` → env var `XENV_KEY` → `.xenv.keys` file
4. decrypts the vault in memory (never written to disk)
5. merges the decrypted vars into the cascade
6. spawns `./server` with the final merged environment
7. if the key is missing, xenv warns to stderr and skips the vault

**that's it.** locally, `.xenv.keys` handles everything. in CI, one env var per environment. the plaintext keyfile never leaves your machine.

### editing encrypted secrets

**option A: atomic edit (recommended for scripts and AI agents).**

```bash
# set a secret — decrypts in memory, patches, re-encrypts. plaintext never touches disk.
xenv edit @production set DATABASE_URL="postgres://prod:new@db:5432/app"

# remove a secret
xenv edit @production delete OLD_KEY

# list key names (no values exposed)
xenv edit @production list
```

**option B: decrypt-edit-encrypt cycle.**

```bash
xenv decrypt @production
vim .xenv.production
xenv encrypt @production
```

option A is safer — the plaintext never exists as a file. option B is easier when you need to edit many keys at once.

### why symmetric instead of asymmetric?

dotenvx uses ECIES (secp256k1 + AES-256-GCM + HKDF) — asymmetric crypto where anyone with the public key can encrypt but only the private key holder can decrypt. that's clever for some workflows. but for env secrets:

- you already control who can encrypt (they have repo access)
- you already control who can decrypt (they have CI access)
- symmetric means one key, not two. half the management, half the surface area
- ECIES adds a public/private keypair dance that buys nothing when the threat model is "don't commit plaintext secrets"

one key per environment — or one key for everything. your call.

---

## comparison

| | xenv | dotenvx | senv | direnv | dotenv | 1Password CLI |
|---|---|---|---|---|---|---|
| **binary size** | ~10 MB | ~50 MB | gem install | ~10 MB | npm/gem | ~100 MB |
| **runtime deps** | none | Node.js (bundled) | Ruby | none | Node.js or Ruby | none (but needs account) |
| **encryption** | AES-256-GCM | ECIES (secp256k1) | Blowfish-CBC | none | none | vault-based |
| **named envs** | `@production` | `-f .env.production` | `@production` | directory-based | manual | `op://vault/item` |
| **execution wrapper** | `xenv @env -- cmd` | `dotenvx run -- cmd` | `senv @env cmd` | shell hook | none | `op run -- cmd` |
| **file extension** | `.xenv` (platform-safe) | `.env` (collides) | `.senv/` directory | `.envrc` | `.env` | none (cloud) |
| **cascade layers** | 7 | 2-4 (convention flag) | merge order | 1 | 4 (Ruby) / 1 (Node) | 3 |
| **zero-disk secrets** | yes | yes | yes | n/a | n/a | yes |
| **key management** | `XENV_KEY_{ENV}` or `XENV_KEY` | `.env.keys` + `DOTENV_PRIVATE_KEY_{ENV}` | `.senv/.key` | n/a | n/a | 1Password account |
| **platforms** | linux, mac, windows | linux, mac, windows | anywhere Ruby runs | linux, mac | anywhere | linux, mac, windows |
| **signal forwarding** | yes | partial (open issues) | yes | n/a | n/a | yes |
| **AI agent support** | MCP server + `--json` | none | none | none | none | none |
| **atomic secret edit** | `edit set` (zero-disk) | none | none | none | none | none |
| **security audit** | `xenv audit` | none | none | none | none | none |
| **cost** | free | free | free | free | free | $4+/user/mo |

---

## file layout

```
your-project/
├── .xenv.keys                  # encryption keys (gitignored, chmod 600)
├── .env                        # legacy base defaults (committed)
├── .xenv                       # modern base defaults (committed)
├── .xenv.production            # prod plaintext (gitignored)
├── .xenv.production.enc        # prod vault (committed)
├── .xenv.staging               # staging plaintext (gitignored)
├── .xenv.staging.enc           # staging vault (committed)
├── .xenv.development           # dev config (committed, no secrets)
├── .xenv.local                 # your machine only (gitignored)
└── .gitignore
```

**.gitignore:**
```
.xenv.keys
.xenv.*.local
.env.*.local
.env.local
.xenv.local
.xenv.production
.xenv.staging
```

---

## ci/cd

set `XENV_KEY_{ENV}` (or just `XENV_KEY` for all environments) in your platform's secret store. xenv reads it from the process environment at runtime. that's the only setup.

```yaml
# GitHub Actions
env:
  XENV_KEY_PRODUCTION: ${{ secrets.XENV_KEY_PRODUCTION }}
steps:
  - run: xenv @production -- ./deploy.sh
```

```dockerfile
# Docker — one binary, no runtime dependencies
FROM alpine:latest
COPY xenv /usr/local/bin/
COPY . /app
WORKDIR /app
CMD ["xenv", "@production", "--", "./server"]
```

```bash
# any platform that supports env vars
heroku config:set XENV_KEY_PRODUCTION="9a3f..."
fly secrets set XENV_KEY_PRODUCTION="9a3f..."
```

---

## agent tools

xenv is built for AI coding agents. every command supports `--json` for machine-readable output. but the real integration is the MCP server.

### `xenv mcp` — model context protocol server

```bash
# register with Claude Code
claude mcp add xenv -- xenv mcp
```

```json
// or add to Claude Desktop's claude_desktop_config.json
{
  "mcpServers": {
    "xenv": {
      "command": "xenv",
      "args": ["mcp"]
    }
  }
}
```

this gives any MCP-compatible AI tool (Claude Code, Cursor, etc.) native access to 7 tools:

| tool | what it does |
|------|-------------|
| `resolve_env` | resolve the full 7-layer cascade, return merged vars as JSON |
| `set_secret` | atomic: decrypt vault in memory → set key → re-encrypt (plaintext never touches disk) |
| `delete_secret` | atomic: decrypt → remove key → re-encrypt |
| `list_secrets` | list key names from a vault (no values exposed) |
| `rotate_key` | generate new key, re-encrypt vault, update `.xenv.keys` |
| `audit` | scan project for security mistakes |
| `validate` | check environment for missing keys, empty secrets, vault issues |

the server speaks JSON-RPC 2.0 over stdio. zero dependencies. no SDK required.

when an AI agent needs to rotate a production key, it calls one tool — not three shell commands. when it needs to add a secret, the plaintext never exists as a file for it to accidentally `git add`.

### `xenv resolve` — dump the cascade

```bash
# human-readable
xenv resolve @production

# JSON — what agents want
xenv resolve @production --json
```

returns the final merged environment after all 7 cascade layers. useful for debugging "where did this value come from?" and for agents that need to inspect the environment before running.

### `xenv diff` — compare plaintext vs vault

```bash
# full diff
xenv diff @production

# key names only (safe for logs and CI output)
xenv diff @production --keys-only

# structured JSON
xenv diff @production --json
```

compares the plaintext `.xenv.{env}` file against the decrypted `.xenv.{env}.enc` vault. shows added, removed, and changed keys. the `--keys-only` flag strips values so it's safe to print in CI logs.

### `xenv validate` — pre-flight checks

```bash
# check for common problems
xenv validate @production

# assert specific keys exist (exits 1 if missing)
xenv validate @production --require DATABASE_URL,STRIPE_KEY

# machine-readable
xenv validate @production --json
```

checks for:
- missing required keys (from `--require` flag or `.xenv.required` manifest file)
- empty values on keys that look like secrets (`*_KEY`, `*_SECRET`, `*_TOKEN`, etc.)
- vault files with no decryption key configured
- plaintext and vault out of sync

exits 0 if ok, 1 if any errors. put it in CI before deploy.

### `xenv audit` — security scanner

```bash
xenv audit
xenv audit --json
```

scans the project for:
- `.xenv.keys` not in `.gitignore`
- plaintext secret files not gitignored
- `.enc` vaults with no key configured (orphan vaults)
- keys in `.xenv.keys` with no corresponding vault (orphan keys)
- sensitive-looking values in unencrypted files (detects `sk_live_*`, `ghp_*`, long hex strings, etc.)

run it in CI. run it before commits. let your AI agent run it after every secret change.

---

## design decisions

**no variable interpolation.** xenv does not expand `${VAR}` references or `$(command)` substitutions inside `.xenv` files. this is intentional — interpolation creates ordering dependencies between variables and opens shell injection vectors. if you need computed values, compute them in your app or your shell.

**no shell interpretation.** `xenv @env -- cmd args` calls `cmd` directly via `execve`, not through a shell. pipes (`|`), redirects (`>`), and `&&` chains won't work. this prevents shell injection. if you need shell features:

```bash
xenv @production -- sh -c "my-script | grep pattern"
```

**CRLF-safe.** files with Windows line endings (`\r\n`), old Mac line endings (`\r`), or UTF-8 BOM are normalized before parsing.

**case sensitivity.** environment names are case-sensitive for file paths — `.xenv.Production` and `.xenv.production` are different files. but decryption key env vars are always uppercased: `@production` and `@Production` both look for `XENV_KEY_PRODUCTION`.

---

## building from source

```bash
# development
bun install
bun test
bun run src/cli.ts @development -- echo "it works"

# compile to binary
bun build ./src/cli.ts --compile --minify --target=bun-linux-x64 --outfile=xenv

# cross-compile targets
bun build ./src/cli.ts --compile --minify --target=bun-darwin-arm64 --outfile=xenv-darwin-arm64
bun build ./src/cli.ts --compile --minify --target=bun-darwin-x64 --outfile=xenv-darwin-x64
bun build ./src/cli.ts --compile --minify --target=bun-linux-arm64 --outfile=xenv-linux-arm64
bun build ./src/cli.ts --compile --minify --target=bun-windows-x64 --outfile=xenv-windows-x64.exe
```

---

## lineage

xenv stands on the shoulders of:

- **[senv](https://github.com/ahoward/senv)** — the `@env` execution pattern, the idea that env management is a *runner*, not a library
- **[sekrets](https://github.com/ahoward/sekrets)** — encrypted config files committed to the repo, key hierarchy, zero-plaintext-on-disk philosophy
- **[dotenvx](https://github.com/dotenvx/dotenvx)** — proving that dotenv needed encryption and a real CLI, pushing the ecosystem forward
- **[direnv](https://github.com/direnv/direnv)** — showing that a single compiled binary and shell integration is the right UX

xenv takes the runner model from senv, the vault philosophy from sekrets, the ambition of dotenvx, and the packaging of direnv — then strips everything else away.

---

## license

MIT
