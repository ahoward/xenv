# xenv

A pure-POSIX shell tool for per-key encrypted environment variables. Every variable is its own file. Every file in `xenv/` is **safe to commit** by design — the secret lives outside the repo, the encrypted values and public KDF params live inside.

57 tests pass under `/bin/sh` and `/usr/bin/dash`. No dependencies beyond `sh`, `openssl` (3.0+ for `kdf`), `awk`, `mktemp`.

## install

There is no installer. Drop the script anywhere on `$PATH`:

```sh
git clone https://github.com/ahoward/xenv.git
cp xenv/bin/xenv ~/bin/xenv     # or /usr/local/bin/xenv, etc.
chmod +x ~/bin/xenv
```

After running `xenv init` in a project, the script copies itself into `xenv/bin/xenv` inside that project. The project is then self-contained — clone it on a new machine, put `myproject/xenv/bin` on PATH, and you're set without re-installing anything.

Requirements:
- `sh` (POSIX — `/bin/sh`, `dash`, busybox `ash`, etc.)
- `openssl` 3.0 or newer (for `openssl kdf PBKDF2`)
- `awk`, `mktemp`, `od` — all POSIX, present everywhere

## what `xenv init` builds

```
xenv/
  README.md                              # docs for humans AND agents
  project.xenv                           # project id (v1:<basename>--<uuid>)
  bin/
    xenv                                 # self-contained copy of the script
  envs/
    testing/
      README.md                          # what vars this env needs
      params.xenv                        # public KDF params (v3:iter:salt-hex)
      APP_ENV.value.enc                  # starter: APP_ENV="testing"
    development/
      README.md
      params.xenv
      APP_ENV.value.enc                  # APP_ENV="development"
    staging/
      README.md
      params.xenv
      APP_ENV.value.enc                  # APP_ENV="staging"
    production/
      README.md
      params.xenv
      APP_ENV.value.enc                  # APP_ENV="production"
```

`xenv/` is the project's environment-store directory. Its children
separate cleanly: `bin/` is the embedded tool, `envs/` is the data.
Future additions (lib/, share/, .cache/) sit alongside `bin/` and
`envs/` — they never collide with environment names.

A separate passphrase is generated per environment and stored in `~/.config/xenv/keys/<env>` (mode 600). The passphrase is the one thing that does **not** live in the repo.

## quick start

```sh
xenv init                                  # set up xenv/ with 4 envs
xenv get development APP_ENV               # → "development"
xenv set development DB_URL=postgres://localhost/myapp
xenv set development PEM_KEY < private.pem # multi-line/binary from file
xenv list development                      # key names only
xenv run development ./server              # exec with env injected
```

## commands

```
xenv init                          create xenv/ with 4 default envs
xenv envs                          list environments
xenv keygen <env> [--keychain|--pass|--file]
                                   create env dir + passphrase
xenv rotate <env>                  rotate passphrase, re-encrypt every key

xenv set    <env> KEY=value        store a value (inline)
xenv set    <env> KEY              read value from stdin (works with `<file`)
xenv get    <env> KEY              decrypt and print (silent on success)
xenv unset  <env> KEY              delete one key (just `rm`)
xenv list   <env>                  list key names — no decryption needed
xenv edit   <env> KEY              decrypt → $VISUAL/$EDITOR → re-encrypt

xenv run    <env> CMD [args]       run command with all keys exported
xenv --     <env> CMD [args]       shorthand for run

xenv help / version
```

## why per-key files?

**Git diffs are surgical.** Rotating one secret touches exactly one file. Code review sees precisely what changed.

**Concurrency is free.** Two `xenv set` calls touching different keys can't race.

**Merge conflicts are tractable.** Two devs adding different keys → no conflict.

**Listing doesn't need decryption.** `xenv list` is `ls` minus the extension.

**Multi-line values just work.** PEM keys, JSON blobs, certificates, binary blobs. The value is a file's contents — no shell quoting.

**Per-key audit trail.** `git log xenv/envs/production/DB_URL.value.enc` shows when that one secret changed.

**Agents can't accidentally leak.** `git add .` adds encrypted `.value.enc` files. Useless without the passphrase, which lives in your keychain or in `$XENV_KEY_<ENV>`.

## project id

`xenv init` writes `xenv/project.xenv` containing a single line:

```
v1:<sanitized-basename>--<32-hex-uuid>
```

For a project at `/home/alice/work/foo`, this might be:
```
v1:foo--7a2c4f8e1b9d3a6f5e8c2b0a4d7e9f1c
```

The project-id is **safe to commit**. It's not a secret — it's just an
identifier that binds this checkout to a unique passphrase storage
location. Two projects with the same basename get different ids (the
UUID part), so they never collide on key storage.

Per-project state lives at `~/.config/xenv/projects/<id>/`:

- `keys/<env>` — the passphrase for each env (mode 600, never committed)
- `origin` — the absolute path of `xenv/` at the time of `init`
- `notes.md` — your per-project notebook (write anything useful)

When a teammate clones the repo, they get the same `project.xenv`. Each
developer runs `xenv keygen <env>` (or shares the passphrase via the
existing channels) to set up their own local copy under their own
`~/.config/xenv/projects/<id>/`.

## crypto

Per-env KDF parameters live in `xenv/envs/<env>/params.xenv`:
```
v3:<iter>:<salt-hex>
```

`iter` is the PBKDF2-SHA256 iteration count, baked into the params file so it can be raised over time. `salt` is 16 random bytes (32 hex). Default iter is 200000.

Per-value envelope (one line in each `KEY.value.enc`):
```
xenv:v3:<iv-hex>:<ct-hex>:<mac-hex>
```

- **IV** — 16 random bytes, per-file
- **Ciphertext** — AES-256-CBC of the value
- **MAC** — HMAC-SHA256 over `"v3:<iv-hex>:<ct-hex>"` using a separate derived key

Encrypt-then-MAC over CBC. The version string is part of the MAC scope; rollback to a future-spec format fails MAC verification.

Same security as AES-GCM for this threat model. GCM would be ideal but `openssl enc` doesn't support AEAD modes in the CLI.

## passphrase resolution

Looked up in this order; first hit wins:

1. `$XENV_KEY_<ENV>` — environment variable
2. `$XENV_KEY` — environment variable (global fallback)
3. `$XDG_CONFIG_HOME/xenv/projects/<project-id>/keys/<env>` — file, mode 600
4. macOS keychain entry `xenv/<project-id>/<env>` (account)
5. `pass show xenv/<project-id>/<env>`

All backends are **scoped by project-id**, so two projects with envs of
the same name never share keys.

Per-project storage can be heterogeneous: project A uses the file, project B uses 1Password's `pass`, project C uses the Keychain. Agents reading the script see the mechanism but never the values.

## threat model

This is a **dev tool for one human (or a small trusted team)**. It protects against:

- accidental commit of plaintext secrets to git (there is no plaintext on disk)
- losing a laptop (passphrase is in keychain, never in the repo)
- the AI agent in your editor that `git add .`'s everything

It does NOT protect against:

- an attacker running commands as the same user (they've already won)
- an attacker who has the passphrase (that's what the passphrase is *for*)
- timing side-channels in the MAC compare (not constant-time)

**No validation of var names, env names, or values.** They go into files as bytes. The only forbidden character is `/` (filesystem rule). Values can contain anything — quotes, newlines, backticks, null bytes — because they're stored as file contents and exported as a shell variable assignment, never as a re-parsed string.

## testing

```sh
test/run.sh                            # uses $SHELL_BIN or /bin/sh
SHELL_BIN=/usr/bin/dash test/run.sh    # verify strict POSIX
```

57 tests. Coverage: init creates the full project layout (`xenv/`, `xenv/bin/xenv`, `xenv/envs/<env>/`), project-id system (unique ids per project, two same-basename projects get different ids, basename sanitization, per-project config dir with keys/origin/notes), `APP_ENV.value.enc` decrypts to its env name, the embedded `xenv/bin/xenv` runs standalone, round-trips, multi-line values, PEM keys, MAC tamper detection, envelope validation, wrong-key MAC failure, env var precedence, missing-env errors, concurrent writes (different keys, same key), partial encrypt failure preserving the original, file structure properties (`.value.enc` extension, `params.xenv` visible, one file per value), and rotation preserving all values.

## notes

- **`xenv run` does PBKDF2 once per call**, not once per key.
- **`xenv list` doesn't need the passphrase.** It just lists files.
- **`openssl 3.0+` required.** macOS ships LibreSSL — install via `brew install openssl@3` and put it first on PATH.
- **`xenv get` is silent on success.** Designed for scripting: `pass=$(xenv get prod API_KEY)` works.
- **`xenv init`** is a heavy one-time setup. After it, `xenv set <env> KEY=value` is the typical workflow.
- **No backwards compat** with previous spike versions. Clean break.
