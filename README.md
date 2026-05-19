# xenv

encrypted environment variables. one file per key. every file safe to commit.

```sh
xenv init                                  # bootstrap xenv/ with 4 envs
xenv set    production DATABASE_URL=postgres://...
xenv set    production TLS_CERT < cert.pem
xenv get    production DATABASE_URL        # silent on success — pipeable
xenv run    production ./server            # exec with the env injected
```

no package manager. no daemon. no `.env` file. no plaintext on disk, ever. one POSIX shell script. 62 tests pass under `/bin/sh` and `/usr/bin/dash`.

```
$ wc -l bin/xenv test/run.sh
  995 bin/xenv
  801 test/run.sh
```

## install

there is no installer. it's a shell script. drop it on `$PATH`:

```sh
git clone https://github.com/ahoward/xenv.git
cp xenv/bin/xenv ~/bin/xenv && chmod +x ~/bin/xenv
```

after `xenv init` in a project, the script copies itself into `xenv/bin/xenv` inside that project. clone the repo on a new machine, put `myproject/xenv/bin` on `$PATH`, and the tool comes along for the ride. no re-install. no version drift.

requirements: `sh`, `openssl 3.0+` (for `kdf`), `awk`, `mktemp`, `od`. all POSIX. all present everywhere. macOS ships LibreSSL — `brew install openssl@3` and put it first on `$PATH`.

## what `xenv init` builds

```
myproject/
└── xenv/                           ← every file here is safe to commit
    ├── README.md                   ← frontmatter (project id) + docs
    ├── bin/
    │   └── xenv                    ← self-contained copy of the script
    └── envs/
        ├── testing/
        │   ├── README.md           ← frontmatter (KDF params) + per-env docs
        │   └── APP_ENV.value.enc   ← AES-256-CBC + HMAC-SHA256
        ├── development/
        ├── staging/
        └── production/
```

every file in `xenv/` is **safe to commit by design**. that's not a slogan. it's the whole point. there is nothing to `.gitignore`, nothing to forget, nothing an `git add .` can leak. the secret — the passphrase — lives outside the repo:

```
~/.config/xenv/projects/myproject--<uuid>/
├── keys/<env>                      ← passphrase, mode 600
├── origin                          ← absolute path of xenv/ at init
└── notes.md                        ← your per-project notebook
```

`rm -rf xenv/` removes the tool cleanly. nothing else in your repo touched.

## commands

```
xenv init                           bootstrap xenv/ + 4 default envs
xenv envs                           list environments
xenv keygen <env> [--keychain|--pass|--file]
                                    create env dir + passphrase
xenv rotate <env>                   rotate passphrase, re-encrypt every key

xenv set    <env> KEY=value         store a value (inline)
xenv set    <env> KEY               read value from stdin (multi-line OK)
xenv get    <env> KEY               decrypt and print (silent on success)
xenv unset  <env> KEY               delete one key
xenv list   <env>                   list key names (no decryption needed)
xenv edit   <env> KEY               decrypt → $EDITOR → re-encrypt
xenv run    <env> CMD [args]        run a command with all keys exported
xenv --     <env> CMD [args]        shorthand for run

xenv help / version
```

a few patterns worth seeing:

```sh
# pipe binary or multi-line values in from a file. no quoting hell.
xenv set production TLS_KEY < server.pem

# round-trip in scripts. xenv get is silent on success.
db=$(xenv get production DATABASE_URL)

# rotate keys without losing your notes — the README body is preserved.
xenv rotate production

# CI: the env var beats every other backend. set it as a platform secret.
XENV_KEY_PRODUCTION=$SECRET xenv run production ./deploy
```

## exit codes & error behavior

scripting against `xenv` should be boring and predictable. here's what you get today:

- **exit 0** — success. `xenv get` prints the value on stdout, nothing on stderr.
- **exit 1** — anything went wrong. error goes to stderr with the `xenv: ` prefix. that includes: no env, no key, wrong passphrase / MAC failure, decrypt failed, tampered envelope, openssl missing, missing or malformed `xenv/README.md` frontmatter.

distinct codes for distinct failures is a future enhancement. for now the safe pattern is:

```sh
if v=$(xenv get production API_KEY 2>/dev/null); then
    use_it "$v"
else
    echo "couldn't fetch API_KEY" >&2
fi
```

a few behavioral details worth knowing:

- **`xenv get` is silent on success.** stdout gets exactly the decrypted bytes, no trailing newline added. `v=$(xenv get prod KEY)` works the way you want.
- **`xenv set KEY` (stdin form) strips a trailing newline.** because `value=$(cat)` and command substitution drops them. if you need a literal trailing newline in a value, pipe in two: `printf 'foo\n\n' | xenv set prod KEY`.
- **`xenv edit` uses `$VISUAL`, then `$EDITOR`, then `vi`.** the plaintext temp file is created with `umask 077` in `${TMPDIR:-/tmp}`, and a `trap` on `EXIT INT TERM HUP` removes it on `^C`, normal exit, or kill. if the editor exits without changes (same sha256 before and after), the encrypted file is not rewritten.
- **`xenv rotate` is all-or-nothing.** every value is decrypted to a tmpfs stash first; the new params and re-encryption only happen if every decrypt succeeded. interrupted mid-rotation leaves the original env untouched.
- **`atomic_write` is `tmp + mv` on the same filesystem.** if `xenv/` lives on NFS or a fuse mount, atomicity depends on the underlying filesystem semantics. don't run `xenv set` concurrently on an NFS-backed `xenv/` and expect the kernel to save you.

## one file per key

each variable lives in its own `KEY.value.enc` file. this is the design choice that makes everything else work:

- **git diffs are surgical.** rotating one secret touches exactly one file. code review sees precisely which secret changed.
- **concurrent writes don't race.** two `xenv set` calls on different keys can't collide.
- **merge conflicts become tractable.** two devs adding different keys never conflict.
- **`xenv list` is just `ls`.** listing key names doesn't need the passphrase. agents and CI scripts can introspect what's defined without ever attempting a decryption that might fail.
- **multi-line values just work.** PEM keys, JSON blobs, certificates, binary blobs. the value is the file's contents — no shell quoting, no escape gymnastics.
- **per-key audit trail.** `git log xenv/envs/production/DB_URL.value.enc` shows when that one secret changed, who changed it, and why (commit message).

every `.value.enc` file is a single line: `xenv:v3:<iv>:<ct>:<mac>`. encrypted, MAC'd, useless without the passphrase.

## KDF params in frontmatter

both READMEs in `xenv/` — the top-level one and one per env — open with YAML frontmatter. **same pattern, applied at both scopes**: project state at the top, crypto state per env. keys are bare (`version`, `iter`, `salt`, `id`); the file's location tells you what they describe.

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
# .value.enc file in this directory. salt and iter are public
# (not secrets); the passphrase that pairs with them is stored
# outside the repo. rotate with: xenv rotate production
version: v3
iter: 200000
salt: a449a01266a1adf926a541ecd72dd2c2
---

# xenv/production

Encrypted environment variables for **production**.
...
```

the body below the fence is yours — document variables, record who has access, leave notes for the next developer. `xenv rotate` rewrites the per-env frontmatter in place and **preserves the body verbatim**. your notes survive a key rotation.

the parser is twenty lines of awk and deliberately naive: for each line in the frontmatter block, split on the **first** `:`, trim whitespace. no quoting, no nesting, no types. `key: value:with:colons` yields key=`key`, value=`value:with:colons`. impossible to misparse because there's nothing to parse cleverly.

## project ids

the project id lives in `xenv/README.md`'s frontmatter, as `id:`. concretely:

```
id: myproject--7a2c4f8e1b9d3a6f5e8c2b0a4d7e9f1c
```

human-readable prefix, 128-bit random suffix. two projects called `foo` on the same machine get different ids, so they never collide on key storage. teammates cloning your repo see the same project id in the README and each set up their own passphrases under their own `~/.config/xenv/projects/<id>/`.

the project id is **safe to commit**. it identifies the project, not the secret.

## passphrase resolution

first hit wins:

1. `$XENV_KEY_<ENV>` — environment variable (CI's friend)
2. `$XENV_KEY` — environment variable (global fallback)
3. `~/.config/xenv/projects/<id>/keys/<env>` — file, mode 600
4. macOS keychain — `xenv` service, `<id>/<env>` account
5. `pass show xenv/<id>/<env>`

all backends are **scoped by project id**, so an env named `production` in project A and `production` in project B never share a key. heterogeneous setups are fine: project A uses the keychain, project B uses `pass`, project C uses the file. agents reading the script see the mechanism but never the values.

## crypto

```
KDF      PBKDF2-SHA256, 200k iterations (raise it in frontmatter)
cipher   AES-256-CBC
MAC      HMAC-SHA256, encrypt-then-MAC
envelope xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>
```

the version string `v3` is part of the MAC scope. rollback to a future format fails MAC verification. encrypt-then-MAC over CBC is the same security as AES-GCM for this threat model. GCM would be ideal but `openssl enc` doesn't expose AEAD in the CLI, and a 1000-line script doesn't get to ship its own AEAD implementation.

the encryption key and MAC key are derived from separate halves of a single PBKDF2 output. one passphrase, two keys, no reuse.

## threat model

this is a **dev tool for one human (or a small trusted team)**. it protects against:

- accidental commit of plaintext secrets (there is no plaintext on disk)
- losing a laptop (passphrase is in your keychain, never in the repo)
- the AI agent in your editor that `git add .`s everything

it does NOT protect against:

- an attacker running commands as the same user (they've already won)
- an attacker who has the passphrase (that's what it's *for*)
- timing side-channels in the MAC compare (not constant-time)

**no input validation.** var names, env names, and values go to disk as bytes. the only forbidden character is `/` (filesystem rule). values can contain quotes, newlines, backticks, null bytes — they're stored as file contents and exported as a shell variable, never re-parsed as a string.

## complex tools create pwnage

a partial list of how secrets actually get leaked:

- **may 2026 — CISA / DHS**. a Nightwing contractor pushed AWS GovCloud admin keys, plaintext passwords, and internal docs to a public github repo. they had **explicitly disabled** GitHub's built-in secret detection because it kept getting in the way. three high-privilege GovCloud accounts compromised; keys stayed valid for 48 hours. (Krebs, [`cisa-admin-leaked-aws-govcloud-keys-on-github`](https://krebsonsecurity.com/2026/05/cisa-admin-leaked-aws-govcloud-keys-on-github/))
- **november 2016 — Uber**. AWS access keys committed to a private github repo. an attacker found them, pulled S3 buckets, exposed 57 million users. the company paid the hacker $100k to "delete it" and didn't disclose for over a year. the secrets were in source control because that was the easiest way to share them between developers.
- **every single day, everywhere**. github's own secret-scanning catches *hundreds of thousands* of leaked credentials per year. gitleaks and trufflehog find more. every leaked `.env`, every `config.yaml` with an inline token, every `aws-credentials.csv`.

the pattern is the same every time. the tooling offered a **secure path** (vault, secret manager, KMS, encrypted store, pre-commit hooks, secret scanning) and an **easy path** (paste it in a file, commit, move on). humans took the easy path. some of them — like the CISA contractor — actively disabled the controls because the controls *got in the way of getting work done*.

xenv refuses to participate in this pattern. there is no secure path vs easy path. there is one path:

- **no `.gitignore` rule to forget.** there's nothing to ignore — every file is encrypted or public-by-design.
- **no secret-detection to disable.** the detection is the design: plaintext can't be in `xenv/` because the tool never puts it there.
- **no "just commit it this once."** there is no plaintext on disk to commit. you'd have to go out of your way to leak — `xenv get prod KEY > leak.txt && git add leak.txt`. that's not a slip-up; that's an act.
- **no separate workflow for sharing.** the encrypted vault is the shared artifact. teammates pull, set up their own passphrase, get to work. the easy path and the secure path are the same path.
- **agents don't need rules either.** an agent that runs `git add .` is fine. an agent that reads `xenv/envs/production/README.md` sees the frontmatter warning before the params and the encrypted blobs below. there is no failure mode here for the agent to fall into.

complex security tools generate workarounds. simple tools that make the right thing the only thing don't.

## testing

```sh
test/run.sh                                # uses $SHELL_BIN or /bin/sh
SHELL_BIN=/usr/bin/dash test/run.sh        # verify strict POSIX
```

62 tests. covers init layout, per-key file model, frontmatter parser at both scopes (project and env), DO-NOT-EDIT warnings on both READMEs, rotation preserving the README body, project-id uniqueness, MAC tamper detection, multi-line and PEM values, concurrent writes, partial-failure atomicity, env-var precedence, and the rest.

## notes

- `xenv run` does PBKDF2 once per call, not once per key
- `xenv list` doesn't need the passphrase — it's `ls` minus the extension
- `xenv get` is silent on success — designed for scripting (`v=$(xenv get prod KEY)`)
- `xenv init` is heavy one-time setup; after that, `xenv set` is the daily driver
- no backwards-compat with previous spike versions. clean break.

## license

MIT. do whatever.
