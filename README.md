# xenv

encrypted environment variables. one file per key. every file safe to commit.

posix. git- and agent-friendly. zero lock-in. simple secrets for discerning developers.

```
xenv
├── README.md                       # frontmatter (project id) + docs
├── bin
│   └── xenv                        # self-contained copy of the tool
└── envs
    └── production
        ├── README.md               # frontmatter (KDF params) + docs
        ├── API_KEY.value.enc       # one encrypted variable per file
        ├── DATABASE_URL.value.enc
        └── TLS_CERT.value.enc      # multi-line / binary values ok
```

```sh
xenv init                            # bootstrap xenv/
xenv set    production API_KEY=sk-…
xenv set    production TLS_CERT < cert.pem
xenv get    production API_KEY       # silent on success — pipeable
xenv run    production ./server      # exec with env injected
xenv rotate production               # new passphrase, re-encrypt all
```

## why

- **per-key files** — surgical diffs. rotate one secret, touch one file. no merge conflicts. multi-line values (PEM, JSON, certs) just work.
- **every file safe to commit** — by design. no `.gitignore` to forget. no plaintext on disk. agents that `git add .` can't leak what isn't there.
- **one POSIX shell script** — no daemon, no package manager, no runtime. `sh + openssl + awk`. 66 tests pass under `/bin/sh` and `/usr/bin/dash`.

## install

```sh
git clone https://github.com/ahoward/xenv && cp xenv/bin/xenv ~/bin/ && chmod +x ~/bin/xenv
```

requires `sh`, `openssl 3.0+`, `awk`, `mktemp`, `od`. macOS: `brew install openssl@3` and put it first on `$PATH`.

after `xenv init`, the script copies itself into `xenv/bin/xenv` inside the project. clone on a new machine, put `myproject/xenv/bin` on `$PATH`, no re-install.

## commands

```
xenv init                            bootstrap xenv/ with 4 default envs
xenv envs                            list environments
xenv keygen <env> [--keychain|--pass|--file]
xenv rotate <env>                    rotate passphrase, re-encrypt all
xenv set    <env> KEY=value          (or: xenv set <env> KEY < file)
xenv get    <env> KEY                decrypt and print (silent on success)
xenv unset  <env> KEY
xenv list   <env>                    list key names — no passphrase needed
xenv edit   <env> KEY                decrypt → $EDITOR → re-encrypt
xenv run    <env> CMD [args]         exec with all keys exported
xenv --     <env> CMD [args]         shorthand for run
```

exit 0 on success, 1 on any failure (error → stderr with `xenv: ` prefix). pipe gives exact bytes; terminal appends one trailing newline if missing (same as `git`, `jq`, `ls --color=auto`).

## layout

every `README.md` opens with YAML frontmatter — project state at the top, crypto state per env. keys are bare; the file's location tells you the scope.

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

`xenv rotate` rewrites the frontmatter and **preserves the body verbatim** — notes survive key rotation. parser is 20 lines of awk: split each line on the first `:`, trim. no quoting, no nesting.

every `.value.enc` is one line: `xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>`. encrypted, MAC'd, useless without the passphrase.

## passphrase resolution

first hit wins:

1. `$XENV_KEY_<ENV>` — env var (CI)
2. `$XENV_KEY` — global fallback
3. `~/.config/xenv/projects/<id>/keys/<env>` — file, mode 600
4. macOS keychain — service `xenv`, account `<id>/<env>`
5. `pass show xenv/<id>/<env>`

all backends scoped by project id, so two `production` envs never share a key. heterogeneous setups are fine (A in keychain, B in pass, C in file).

## crypto

```
KDF      PBKDF2-SHA256, 200k iterations (raise it in frontmatter)
cipher   AES-256-CBC
MAC      HMAC-SHA256, encrypt-then-MAC
envelope xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>
```

`v3` is in the MAC scope — rollback to a future format fails MAC verification. encryption key and MAC key are the two halves of one PBKDF2 output: one passphrase, two keys, no reuse.

## xenv is just a posix helper

the encrypt/decrypt functions in this repo *are* the spec. ~15 lines each:

- [`derive_keys`](bin/xenv#L253) — `passphrase + salt + iter → enc-key + mac-key`. PBKDF2-SHA256.
- [`encrypt_value`](bin/xenv#L278) — plaintext → `xenv:v3:<iv>:<ct>:<mac>`. AES-256-CBC + HMAC-SHA256.
- [`decrypt_value`](bin/xenv#L301) — envelope → plaintext. MAC verify first, then decrypt.

read those three functions and you've read xenv. no proprietary format, no library lock-in, no runtime. **xenv is a convention plus a 1000-line POSIX shell wrapper around `openssl(1)`.**

to prove this, [`loaders/`](loaders/) holds reference loaders in four languages, all generated from a single [`AGENT_PROMPT.md`](loaders/AGENT_PROMPT.md):

- [`loaders/pythong/`](loaders/pythong/xenv.py) — stdlib + `openssl(1)` for AES
- [`loaders/node/`](loaders/node/xenv.js) — pure stdlib `crypto`
- [`loaders/go/`](loaders/go/xenv/xenv.go) — stdlib + `golang.org/x/crypto/pbkdf2`
- [`loaders/rust/`](loaders/rust/src/lib.rs) — RustCrypto crates

`loaders/test.sh` exercises all four against a real vault. any language with PBKDF2-SHA256 + HMAC-SHA256 + AES-256-CBC can write its own.

if this tool ever disappeared, your data wouldn't.

## phoenix architecture

design takes after Chad Fowler's [phoenix architecture](https://www.infoq.com/news/2013/08/immutable-servers/) — *trash your servers and burn your code*. nothing on the running system is special; everything reconstructs from source.

- **vault** ← committed `.value.enc` bytes + passphrase
- **tool** ← self-contained script copied at `xenv init`
- **format** ← [`loaders/AGENT_PROMPT.md`](loaders/AGENT_PROMPT.md): burn all loaders, an agent rebuilds them
- **docs** ← generated by `bin/xenv` itself, can't drift from the code

burn it all down. it rises from the ashes.

## threat model

a **dev tool for one human or a small trusted team**. protects against:

- accidental commit of plaintext secrets (none on disk)
- losing a laptop (passphrase outside the repo)
- the AI in your editor that `git add .`s everything

does NOT protect against same-user attackers, an attacker who has the passphrase, or timing side-channels in MAC compare.

**no input validation.** var names, env names, and values are bytes. quotes, newlines, backticks, null bytes — all fine, stored verbatim, never re-parsed.

## complex tools create pwnage

a partial list of how secrets actually get leaked:

- **may 2026 — CISA / DHS**: contractor pushed AWS GovCloud admin keys to a public repo. they had **explicitly disabled** GitHub's secret detection. ([Krebs](https://krebsonsecurity.com/2026/05/cisa-admin-leaked-aws-govcloud-keys-on-github/))
- **2016 — Uber**: AWS keys in a private repo, 57M users exposed, $100k hush payment, disclosure delayed a year.
- **every day**: github catches hundreds of thousands of leaked credentials per year. gitleaks and trufflehog find more.

the pattern is always the same. tooling offered a *secure path* (vault, KMS, pre-commit hooks) and an *easy path* (paste it in a file, commit, move on). humans took the easy path; some actively disabled the controls because they *got in the way of getting work done*.

xenv has no easy/secure split. one path:

- no `.gitignore` to forget — every file is encrypted or public-by-design
- no secret detection to disable — the detection IS the design
- no "just commit it this once" — there's no plaintext on disk to commit
- no separate workflow for sharing — the encrypted vault IS the artifact

complex security tools generate workarounds. simple tools that make the right thing the only thing don't.

## testing

```sh
test/run.sh                          # uses $SHELL_BIN or /bin/sh
SHELL_BIN=/usr/bin/dash test/run.sh  # verify strict POSIX
loaders/test.sh                      # round-trip vs all four loaders
```

66 tests + 24 loader assertions. covers init layout, per-key file model, frontmatter parser at both scopes, rotation preserving the body, MAC tamper detection, multi-line and PEM values, concurrent writes, partial-failure atomicity, env-var precedence, tty-aware output.

## license

MIT. do whatever.
