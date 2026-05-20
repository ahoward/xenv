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
xenv @production ./server            # exec with env injected (== xenv run production ./server)
xenv rotate production               # new passphrase, re-encrypt all
```

---

## NAME

xenv — encrypted environment variables, one file per key

## SYNOPSIS

```
xenv init
xenv envs
xenv keygen <env> [--keychain | --pass | --file]
xenv rotate <env>
xenv set    <env> KEY=value
xenv set    <env> KEY                  # value on stdin
xenv get    <env> KEY
xenv unset  <env> KEY
xenv list   <env>
xenv edit   <env> KEY
xenv run    <env> CMD [args]
xenv @<env>      CMD [args]            # shorthand for run
xenv help | version
```

## DESCRIPTION

xenv stores encrypted environment variables in a project's repository. Each variable lives in its own `<KEY>.value.enc` file as a single line of the form `xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>`. Per-env KDF parameters (`version`, `iter`, `salt`) live in YAML frontmatter at the top of a sibling `README.md`. The passphrase paired with those parameters lives outside the repo — in an environment variable, a mode-600 file under `~/.config/xenv/`, the macOS keychain, or `pass(1)`.

Every file in `xenv/` is safe to commit by design. The encryption key is the only thing that must not be committed; the design makes it impossible to put it there by accident.

xenv is a POSIX shell script. It depends on `sh`, `openssl(1)` 3.0+, `awk`, `mktemp`, and `od`. After `xenv init`, the script copies itself into `xenv/bin/xenv` inside the project — clone on a new machine, put `myproject/xenv/bin` on `$PATH`, no re-install needed.

## COMMANDS

`init`
> Bootstrap `xenv/` with four default envs (testing, development, staging, production), generate per-env passphrases, write the project id into `xenv/README.md`.

`envs`
> List environments and which have a known passphrase locally.

`keygen <env> [--keychain | --pass | --file]`
> Create a new env directory and generate a fresh passphrase. The backend flag selects where the passphrase is stored locally.

`rotate <env>`
> Generate a new passphrase, re-encrypt every value in the env. All-or-nothing: every value is decrypted to a tmpfs stash first; new params and re-encryption only commit if every decrypt succeeded.

`set <env> KEY=value`
> Store an encrypted value. With no `=`, reads the value from stdin (multi-line / binary OK). Stdin form strips one trailing newline (`value=$(cat)`); pipe in two if a literal trailing newline is needed.

`get <env> KEY`
> Decrypt and print to stdout. Silent on success. In a pipe / redirect / `$()`, emits exact bytes — no trailing newline added. Interactive at a terminal: appends one trailing newline if missing, so the next shell prompt isn't glued to the value. Same auto-detection as `git`, `jq`, `ls --color=auto`.

`unset <env> KEY`
> Delete one key. Just `rm`.

`list <env>`
> List key names. Doesn't need the passphrase — `ls` minus the extension.

`edit <env> KEY`
> Decrypt to a tmpfile (mode 600 in `$TMPDIR`), invoke `$VISUAL` or `$EDITOR` or `vi`, re-encrypt on exit. The tmpfile is cleaned via `trap` on `EXIT INT TERM HUP`. If the editor closes without changes, the encrypted file is not rewritten.

`run <env> CMD [args]`
> Decrypt every value in the env, export each as a shell variable, then `exec` CMD with the env injected. PBKDF2 runs once per call, not once per key. `xenv @<env> CMD [args]` is the screaming-loud shorthand: `xenv @production ./deploy`.

`help`, `version`
> What they say.

## ENVIRONMENT

`XENV_KEY_<ENV>`
> Per-env passphrase. Highest priority. `<ENV>` is the env name uppercased with `-` replaced by `_`. For CI, set this as a platform secret.

`XENV_KEY`
> Global passphrase fallback. Used if no per-env variable is set.

`XENV_ROOT`
> Override the location of the encrypted tree. Default: `./xenv`. Used by the loaders in `loaders/`; the shell tool always uses `./xenv`.

`VISUAL`, `EDITOR`
> Editor for `xenv edit`. `$VISUAL` wins, then `$EDITOR`, then `vi`.

`XDG_CONFIG_HOME`
> Per-project state lives under `$XDG_CONFIG_HOME/xenv/projects/<id>/`. Default: `~/.config`.

`TMPDIR`
> Used by `xenv edit` and `xenv rotate` for their plaintext stashes. Default: `/tmp`.

## FILES

`xenv/README.md`
> Project state. YAML frontmatter holds `version` and `id`. Body is yours.

`xenv/bin/xenv`
> Self-contained copy of the script, written at `xenv init` so the project is portable.

`xenv/envs/<env>/README.md`
> Per-env state. YAML frontmatter holds `version`, `iter`, `salt`. Body is yours; survives `xenv rotate` verbatim.

`xenv/envs/<env>/<KEY>.value.enc`
> One encrypted value per file. Format: `xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>`.

`~/.config/xenv/projects/<id>/keys/<env>`
> Mode-600 passphrase, file backend. Never in the repo.

`~/.config/xenv/projects/<id>/origin`
> Absolute path of `xenv/` at the time of `init`. Informational.

`~/.config/xenv/projects/<id>/notes.md`
> Per-project notebook. Survives `rm -rf xenv/` and re-init.

## EXIT STATUS

`0`
> Success.

`1`
> Any error. Message on stderr with `xenv: ` prefix. Covers no env, no key, wrong passphrase, MAC failure, malformed envelope, openssl missing, malformed frontmatter.

## EXAMPLES

Install:

```sh
git clone https://github.com/ahoward/xenv && cp xenv/bin/xenv ~/bin/ && chmod +x ~/bin/xenv
```

Bootstrap and use:

```sh
xenv init
xenv set production API_KEY=sk-abc
xenv get production API_KEY
xenv @production ./server
```

Pipe binary or multi-line values in from a file:

```sh
xenv set production TLS_KEY < server.pem
```

Round-trip in a script:

```sh
db=$(xenv get production DATABASE_URL)
```

CI deploy with the env injected:

```sh
XENV_KEY_PRODUCTION=$SECRET xenv @production ./deploy
```

Safe error handling:

```sh
if v=$(xenv get production API_KEY 2>/dev/null); then
    use_it "$v"
else
    echo "couldn't fetch API_KEY" >&2
fi
```

## DIAGNOSTICS

`atomic_write` is `tmp + mv` on the same filesystem. If `xenv/` lives on NFS, atomicity is up to the underlying filesystem.

The frontmatter parser is 20 lines of awk: split each line on the first `:`, trim whitespace, skip comments and blanks. No quoting, no nesting, no types. `key: value:with:colons` yields key=`key`, value=`value:with:colons`.

Per-env passphrase backends are scoped by project id, so an env named `production` in project A and `production` in project B never share a key. Heterogeneous setups are fine: A in keychain, B in pass, C in file.

Passphrase resolution, first hit wins:

1. `$XENV_KEY_<ENV>`
2. `$XENV_KEY`
3. `~/.config/xenv/projects/<id>/keys/<env>` (mode 600)
4. macOS keychain — service `xenv`, account `<id>/<env>`
5. `pass show xenv/<id>/<env>`

## SECURITY

A dev tool for one human or a small trusted team. Protects against accidental commit of plaintext (no plaintext on disk), losing a laptop (passphrase outside the repo), and AI agents that `git add .` everything.

Does NOT protect against same-user attackers, an attacker who has the passphrase, or timing side-channels in the MAC compare (not constant-time).

```
KDF      PBKDF2-SHA256, 200k iterations (raise it in frontmatter)
cipher   AES-256-CBC
MAC      HMAC-SHA256, encrypt-then-MAC
envelope xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>
```

`v3` is in the MAC scope; rollback to a future format fails MAC verification. Encryption key and MAC key are the two halves of one PBKDF2 output — one passphrase, two keys, no reuse.

No input validation. Var names, env names, and values are bytes. Quotes, newlines, backticks, null bytes — stored verbatim, never re-parsed.

## RATIONALE

The encrypt and decrypt functions in this repo *are* the spec. ~15 lines each:

- [`derive_keys`](bin/xenv#L253) — `passphrase + salt + iter → enc-key + mac-key`. PBKDF2-SHA256.
- [`encrypt_value`](bin/xenv#L278) — plaintext → `xenv:v3:<iv>:<ct>:<mac>`. AES-256-CBC + HMAC-SHA256.
- [`decrypt_value`](bin/xenv#L301) — envelope → plaintext. MAC verify first, then decrypt.

Read those three functions and you've read xenv. No proprietary format, no library lock-in, no runtime. xenv is a convention plus a 1000-line POSIX shell wrapper around `openssl(1)`. To prove this, [`loaders/`](loaders/) holds reference loaders in Python, Node, Go, and Rust, all generated from a single [`AGENT_PROMPT.md`](loaders/AGENT_PROMPT.md). `loaders/test.sh` exercises all four against a real vault.

The design takes after Chad Fowler's [phoenix architecture](https://www.infoq.com/news/2013/08/immutable-servers/) — *trash your servers and burn your code*. Nothing on the running system is special; everything reconstructs from source. The vault reconstructs from committed bytes plus the passphrase. The tool reconstructs from this repo. The format reconstructs from `AGENT_PROMPT.md`. The docs are generated by `bin/xenv` itself.

Why this matters, as a partial list of how secrets actually leak:

- **May 2026 — CISA/DHS.** A contractor pushed AWS GovCloud admin keys to a public repo. They had explicitly disabled GitHub's secret detection. ([Krebs](https://krebsonsecurity.com/2026/05/cisa-admin-leaked-aws-govcloud-keys-on-github/))
- **2016 — Uber.** AWS keys in a private repo. 57M users exposed. $100k hush payment. Disclosure delayed a year.
- **Every day.** GitHub catches hundreds of thousands of leaked credentials per year. Gitleaks and trufflehog find more.

Each leak follows the same pattern: tooling offered a *secure path* (vault, KMS, pre-commit hooks) and an *easy path* (paste it in a file, commit, move on). Humans took the easy path; some actively disabled the controls. xenv has no easy/secure split — there is one path, and the right thing is the only thing. No `.gitignore` to forget, no secret detection to disable, no plaintext on disk to commit, no separate workflow for sharing.

## TESTING

```sh
test/run.sh                          # uses $SHELL_BIN or /bin/sh
SHELL_BIN=/usr/bin/dash test/run.sh  # verify strict POSIX
loaders/test.sh                      # round-trip against all four loaders
```

66 shell tests, 24 loader assertions. Covers init layout, per-key file model, frontmatter parser at both scopes, rotation preserving the body, MAC tamper detection, multi-line and PEM values, concurrent writes, partial-failure atomicity, env-var precedence, tty-aware output.

## SEE ALSO

`openssl(1)`, `pass(1)`, `gpg(1)`, `security(1)` (macOS), [`loaders/AGENT_PROMPT.md`](loaders/AGENT_PROMPT.md).

## AUTHOR

xenv is by [@ahoward](https://github.com/ahoward), MIT licensed. Source at <https://github.com/ahoward/xenv>.
