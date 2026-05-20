# xenv

encrypted environment variables. one file per key. every file safe to commit.

posix compliant. git and agent friendly. zero lock-in. simple secrets management for discerning developers.

```
xenv
├── README.md                       # frontmatter (project id) + docs
├── bin
│   └── xenv                        # self-contained copy of the tool
└── envs
    ├── development
    │   ├── APP_ENV.value.enc
    │   └── README.md
    ├── production
    │   ├── API_KEY.value.enc       # one encrypted variable per file
    │   ├── APP_ENV.value.enc
    │   ├── DATABASE_URL.value.enc
    │   ├── README.md               # frontmatter (KDF params) + docs
    │   └── TLS_CERT.value.enc      # multi-line / binary values ok
    ├── staging
    │   ├── APP_ENV.value.enc
    │   └── README.md
    └── testing
        ├── APP_ENV.value.enc
        └── README.md
```

```sh
xenv init                            # bootstrap the tree above
xenv set    production API_KEY=sk-…  # store an encrypted value
xenv set    production TLS_CERT < cert.pem
xenv get    production API_KEY       # decrypt and print (silent on success)
xenv list   production               # list key names (no passphrase needed)
xenv run    production ./server      # exec with the env injected
xenv rotate production               # new passphrase, re-encrypt every key
```

## why

- **per-key files** — surgical diffs. rotate one secret, touch one file. no merge conflicts when two devs add different keys. multi-line values (PEM, JSON, certs) just work.
- **every file safe to commit** — by design. no `.gitignore` to forget. no plaintext on disk. agents that `git add .` can't leak what isn't there.
- **one POSIX shell script** — no daemon, no package manager, no runtime. `sh + openssl + awk`. 63 tests pass under `/bin/sh` and `/usr/bin/dash`.

## usage

```
xenv init                            bootstrap xenv/ with 4 default envs
xenv envs                            list environments
xenv keygen <env> [--keychain|--pass|--file]
                                     create env dir + passphrase
xenv rotate <env>                    rotate passphrase, re-encrypt every key

xenv set    <env> KEY=value          store a value (inline)
xenv set    <env> KEY                read value from stdin (multi-line OK)
xenv get    <env> KEY                decrypt and print (silent on success)
xenv unset  <env> KEY                delete one key
xenv list   <env>                    list key names (no decryption needed)
xenv edit   <env> KEY                decrypt → $EDITOR → re-encrypt

xenv run    <env> CMD [args]         run command with all keys exported
xenv --     <env> CMD [args]         shorthand for run

xenv help / version
```

patterns:

```sh
# pipe binary or multi-line values in from a file. no quoting hell.
xenv set production TLS_KEY < server.pem

# round-trip in scripts. xenv get is silent on success.
db=$(xenv get production DATABASE_URL)

# CI: env var beats every other backend. set it as a platform secret.
XENV_KEY_PRODUCTION=$SECRET xenv run production ./deploy
```

## exit codes

- **0** — success. `xenv get` prints decrypted bytes on stdout, nothing on stderr.
- **1** — anything went wrong. error goes to stderr with `xenv: ` prefix. covers: no env, no key, wrong passphrase / MAC failure, decrypt failed, tampered envelope, openssl missing, missing or malformed `xenv/README.md` frontmatter.

distinct codes for distinct failures is a future enhancement. the safe pattern today:

```sh
if v=$(xenv get production API_KEY 2>/dev/null); then
    use_it "$v"
else
    echo "couldn't fetch API_KEY" >&2
fi
```

a few details worth knowing:

- **`xenv get` is silent on success.** stdout gets exactly the decrypted bytes, no trailing newline added.
- **`xenv set KEY` (stdin form) strips a trailing newline** (because `value=$(cat)`). if you need one literally, pipe in two: `printf 'foo\n\n' | xenv set prod KEY`.
- **`xenv edit` uses `$VISUAL`, then `$EDITOR`, then `vi`.** the plaintext temp file is created with `umask 077` in `${TMPDIR:-/tmp}`, with a `trap` on `EXIT INT TERM HUP` so `^C` cleans up.
- **`xenv rotate` is all-or-nothing.** every value is decrypted to a tmpfs stash first; new params + re-encryption only happen if every decrypt succeeded.
- **`atomic_write` is `tmp + mv` on the same filesystem.** if `xenv/` lives on NFS, atomicity is up to the underlying filesystem.

## install

```sh
git clone https://github.com/ahoward/xenv.git
cp xenv/bin/xenv ~/bin/xenv && chmod +x ~/bin/xenv
```

after `xenv init` in a project, the script copies itself into `xenv/bin/xenv` inside that project. clone the repo on a new machine, put `myproject/xenv/bin` on `$PATH`, and the tool comes along for the ride. no re-install, no version drift.

**requirements**: `sh`, `openssl 3.0+` (for `kdf`), `awk`, `mktemp`, `od`. macOS ships LibreSSL — `brew install openssl@3` and put it first on `$PATH`.

## layout

every `README.md` opens with YAML frontmatter. **same pattern, both scopes**: project state at the top, crypto state per env. keys are bare; the file's location tells you what they describe.

top-level `xenv/README.md`:

```yaml
---
# xenv project state — DO NOT EDIT — managed by xenv
version: v1
id: myproject--7a2c4f8e1b9d3a6f5e8c2b0a4d7e9f1c
---

# xenv/
...
```

per-env `xenv/envs/production/README.md`:

```yaml
---
# xenv crypto state — DO NOT EDIT — managed by xenv
# changing these breaks decryption. rotate with: xenv rotate production
version: v3
iter: 200000
salt: a449a01266a1adf926a541ecd72dd2c2
---

# xenv/production
...
```

the body below the fence is yours — document variables, record who has access, leave notes for the next developer. `xenv rotate` rewrites the per-env frontmatter in place and **preserves the body verbatim**. your notes survive a key rotation.

the parser is twenty lines of awk and deliberately naive: for each line, split on the **first** `:`, trim whitespace. no quoting, no nesting, no types.

every `.value.enc` is a single line:

```
xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>
```

encrypted, MAC'd, useless without the passphrase.

## passphrase resolution

first hit wins:

1. `$XENV_KEY_<ENV>` — environment variable (CI's friend)
2. `$XENV_KEY` — environment variable (global fallback)
3. `~/.config/xenv/projects/<id>/keys/<env>` — file, mode 600
4. macOS keychain — `xenv` service, `<id>/<env>` account
5. `pass show xenv/<id>/<env>`

all backends are **scoped by project id**, so an env named `production` in project A and `production` in project B never share a key. project A can use the keychain, B can use `pass`, C can use the file — agents reading the script see the mechanism but never the values.

## crypto

```
KDF      PBKDF2-SHA256, 200k iterations (raise it in frontmatter)
cipher   AES-256-CBC
MAC      HMAC-SHA256, encrypt-then-MAC
envelope xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>
```

the version string `v3` is part of the MAC scope. rollback to a future format fails MAC verification. encrypt-then-MAC over CBC is the same security as AES-GCM for this threat model. GCM would be ideal but `openssl enc` doesn't expose AEAD in the CLI, and a 1000-line script doesn't get to ship its own AEAD implementation.

the encryption key and MAC key are derived from separate halves of a single PBKDF2 output. one passphrase, two keys, no reuse.

## xenv is just a posix helper

the encrypt/decrypt functions in this repo *are* the spec. each is ~15 lines of POSIX shell with `openssl(1)` calls. nothing else implements anything that isn't visible here.

- [`derive_keys`](bin/xenv#L253) — `passphrase + salt + iter → enc-key + mac-key`. PBKDF2-SHA256.
- [`encrypt_value`](bin/xenv#L278) — plaintext → `xenv:v3:<iv>:<ct>:<mac>`. AES-256-CBC + HMAC-SHA256.
- [`decrypt_value`](bin/xenv#L301) — envelope → plaintext. MAC verify first, then decrypt.

read those three functions and you've read xenv. there is no proprietary format, no library lock-in, no runtime. **xenv is a convention plus a 1000-line POSIX shell wrapper around `openssl(1)`.** the convention is what matters; the wrapper is convenience.

to prove this, [`loaders/`](loaders/) holds reference read-only loaders in four languages, all generated from a single [`AGENT_PROMPT.md`](loaders/AGENT_PROMPT.md):

- [`loaders/pythong/xenv.py`](loaders/pythong/xenv.py) — 150 lines, stdlib + `openssl(1)` for AES
- [`loaders/node/xenv.js`](loaders/node/xenv.js) — 150 lines, pure stdlib `crypto`
- [`loaders/go/xenv/xenv.go`](loaders/go/xenv/xenv.go) — 240 lines, stdlib + `golang.org/x/crypto/pbkdf2`
- [`loaders/rust/src/lib.rs`](loaders/rust/src/lib.rs) — 250 lines, RustCrypto crates (`aes` + `cbc` + `hmac` + `sha2` + `pbkdf2`)

`loaders/test.sh` exercises all three against a real vault. an agent with this README and the prompt file can produce a working loader in any language with PBKDF2-SHA256, HMAC-SHA256, and AES-256-CBC primitives (which is every modern language).

if this tool ever disappeared, your data wouldn't.

## prior art: phoenix architecture

the design takes after Chad Fowler's [phoenix architecture](https://www.infoq.com/news/2013/08/immutable-servers/) — "Trash Your Servers and Burn Your Code." nothing on the running system is special, because everything is reconstructable from source. burn it all down, and it rises from the ashes.

xenv applies the same idea to secrets state:

- **the encrypted vault** (`xenv/envs/*/*.value.enc`) reconstructs from the committed bytes plus the passphrase. no hidden state on the running machine.
- **the tool** (`bin/xenv`) reconstructs from this repo. it's a self-contained POSIX shell script copied into each project at `xenv init` — clone the project on a new machine and the tool comes with it.
- **the format** reconstructs from `loaders/AGENT_PROMPT.md`. burn down every loader in this repo and an agent reading the prompt can regenerate equivalent ones in any language.
- **the doc** reconstructs from the code. the embedded README that `xenv init` writes is generated by `bin/xenv` itself — there's no hand-edited document that could drift from the implementation.

## threat model

a **dev tool for one human (or a small trusted team)**. it protects against:

- accidental commit of plaintext secrets — there is no plaintext on disk
- losing a laptop — passphrase is in your keychain, never in the repo
- the AI agent in your editor that `git add .`s everything

it does NOT protect against:

- an attacker running commands as the same user (they've already won)
- an attacker who has the passphrase (that's what it's *for*)
- timing side-channels in the MAC compare (not constant-time)

**no input validation.** var names, env names, and values go to disk as bytes. values can contain quotes, newlines, backticks, null bytes — they're stored as file contents and exported as a shell variable, never re-parsed.

## complex tools create pwnage

a partial list of how secrets actually get leaked:

- **may 2026 — CISA / DHS**. a Nightwing contractor pushed AWS GovCloud admin keys, plaintext passwords, and internal docs to a public github repo. they had **explicitly disabled** GitHub's built-in secret detection because it kept getting in the way. three high-privilege GovCloud accounts compromised; keys stayed valid for 48 hours. (Krebs, [`cisa-admin-leaked-aws-govcloud-keys-on-github`](https://krebsonsecurity.com/2026/05/cisa-admin-leaked-aws-govcloud-keys-on-github/))
- **november 2016 — Uber**. AWS access keys committed to a private github repo. an attacker found them, pulled S3 buckets, exposed 57 million users. paid the hacker $100k to "delete it" and didn't disclose for over a year.
- **every single day**. github's own secret-scanning catches hundreds of thousands of leaked credentials per year. gitleaks and trufflehog find more.

the pattern is the same every time. tooling offered a **secure path** (vault, KMS, encrypted store, pre-commit hooks, secret scanning) and an **easy path** (paste it in a file, commit, move on). humans took the easy path. some — like the CISA contractor — actively disabled the controls because they *got in the way of getting work done*.

xenv refuses to participate in this pattern. there is no secure path vs easy path. there is one path:

- **no `.gitignore` rule to forget.** every file is encrypted or public-by-design.
- **no secret-detection to disable.** the detection is the design — plaintext can't be in `xenv/` because the tool never puts it there.
- **no "just commit it this once."** there is no plaintext on disk to commit.
- **no separate workflow for sharing.** the encrypted vault is the shared artifact.
- **agents don't need rules either.** an agent that runs `git add .` is fine. an agent reading any `xenv/README.md` sees the frontmatter warning before the values.

complex security tools generate workarounds. simple tools that make the right thing the only thing don't.

## testing

```sh
test/run.sh                                # uses $SHELL_BIN or /bin/sh
SHELL_BIN=/usr/bin/dash test/run.sh        # verify strict POSIX
```

63 tests. covers init layout, per-key file model, frontmatter parser at both scopes, DO-NOT-EDIT warnings on both READMEs, rotation preserving the README body, project-id uniqueness, MAC tamper detection, multi-line and PEM values, concurrent writes, partial-failure atomicity, env-var precedence, top-level README documenting `XENV_KEY_<ENV>`, and the rest.

## notes

- `xenv run` does PBKDF2 once per call, not once per key
- `xenv list` doesn't need the passphrase — it's `ls` minus the extension
- `xenv get` is silent on success — designed for scripting (`v=$(xenv get prod KEY)`)
- `xenv init` is heavy one-time setup; after that, `xenv set` is the daily driver
- no backwards-compat with previous spike versions. clean break.

## license

MIT. do whatever.
