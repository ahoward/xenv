# xenv

encrypted environment variables. one file per key. every file safe to commit.

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
- **one POSIX shell script** — no daemon, no package manager, no runtime. `sh + openssl + awk`. 62 tests pass under `/bin/sh` and `/usr/bin/dash`.

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
# changing any value in this block breaks decryption of every
# .value.enc file in this directory. salt and iter are public.
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

## without xenv

the format is openable with bare `openssl(1)`. if this tool ever disappeared, your data wouldn't. an agent (or a future you, or a future me) staring at a `.value.enc` and a per-env README can recover the plaintext with the recipe below.

decrypt one value:

```sh
PASS=$(cat ~/.config/xenv/projects/<project-id>/keys/production)
SALT=$(awk '/^salt:/ {print $2}' xenv/envs/production/README.md)
ITER=$(awk '/^iter:/ {print $2}' xenv/envs/production/README.md)

# PBKDF2-SHA256 → 64 bytes; first 32 = enc key, last 32 = MAC key
KEYS=$(openssl kdf -keylen 64 -kdfopt digest:SHA256 \
       -kdfopt "pass:$PASS" -kdfopt "hexsalt:$SALT" \
       -kdfopt "iter:$ITER" -binary PBKDF2 \
       | od -An -vtx1 | tr -d ' \n')
ENC_KEY=$(printf '%s' "$KEYS" | cut -c1-64)
MAC_KEY=$(printf '%s' "$KEYS" | cut -c65-128)

IFS=: read -r _ _ IV CT MAC < xenv/envs/production/HELLO.value.enc

# verify MAC first (encrypt-then-MAC; "v3:<iv>:<ct>" is the MAC scope)
EXPECTED=$(printf 'v3:%s:%s' "$IV" "$CT" \
           | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$MAC_KEY" -binary \
           | od -An -vtx1 | tr -d ' \n')
[ "$MAC" = "$EXPECTED" ] || { echo "MAC mismatch" >&2; exit 1; }

# decrypt
printf '%s' "$CT" | xxd -r -p \
  | openssl enc -d -aes-256-cbc -K "$ENC_KEY" -iv "$IV"
```

encrypt one value (assuming `$ENC_KEY` + `$MAC_KEY` already derived as above):

```sh
IV=$(openssl rand -hex 16)
CT=$(printf '%s' "$plaintext" \
     | openssl enc -aes-256-cbc -K "$ENC_KEY" -iv "$IV" \
     | od -An -vtx1 | tr -d ' \n')
MAC=$(printf 'v3:%s:%s' "$IV" "$CT" \
      | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$MAC_KEY" -binary \
      | od -An -vtx1 | tr -d ' \n')
printf 'xenv:v3:%s:%s:%s\n' "$IV" "$CT" "$MAC" > xenv/envs/production/HELLO.value.enc
```

inject for one command (no `xenv run` needed, since you have the plaintext):

```sh
HELLO=$(...the decrypt recipe above...) ./your-command
```

this isn't a replacement workflow — it's a proof of openness. `xenv` itself uses exactly these primitives (see `derive_keys`, `encrypt_value`, `decrypt_value` in `bin/xenv`).

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

62 tests. covers init layout, per-key file model, frontmatter parser at both scopes, DO-NOT-EDIT warnings on both READMEs, rotation preserving the README body, project-id uniqueness, MAC tamper detection, multi-line and PEM values, concurrent writes, partial-failure atomicity, env-var precedence, and the rest.

## notes

- `xenv run` does PBKDF2 once per call, not once per key
- `xenv list` doesn't need the passphrase — it's `ls` minus the extension
- `xenv get` is silent on success — designed for scripting (`v=$(xenv get prod KEY)`)
- `xenv init` is heavy one-time setup; after that, `xenv set` is the daily driver
- no backwards-compat with previous spike versions. clean break.

## license

MIT. do whatever.
