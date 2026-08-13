# AGENTS.md — xenv

Machine-facing entry doc for coding agents. Mirrors the site `llms.txt`
(`site/build`); keep the two in sync with the real CLI surface. A repo that
*uses* xenv can copy this file to its own root.

xenv is a **git-backed secrets vault**: encrypted, per-key, commit-safe
environment variables. A POSIX shell script over OpenSSL 3.x. Everything under
`xenv/` is safe to commit; the passphrase is the only secret and never lives
in the repo.

## Detect

A project uses xenv iff it has an `xenv/` directory:

    xenv/
    ├── README.md            # project id (YAML frontmatter)
    └── envs/<env>/
        ├── README.md         # KDF params (frontmatter)
        └── <KEY>.value.enc   # one encrypted value per file

Environments are the subdirectories of `xenv/envs/`. Exactly one (the common
case) → it is the default and `@<env>` is optional; several → pick by name
(or set `$XENV_ENV`). An explicit `@<env>` always wins.

## Resolve the binary  (resolution order)

1. `$XENV_BIN`              — explicit path, always wins
2. `./xenv/bin/xenv`        — the vendored copy `xenv setup` writes into the repo
3. `xenv` on `$PATH`
4. **opt-in** install/fetch — humans: `curl -fsSL https://xenv.sh/install | sh`
   (pinned release, sha256-verified before it touches disk). An automated
   `$XENV_AUTOFETCH=1` resolver step (fetch → verify → cache in
   `~/.cache/xenv/`, never silent, never on import) is spec'd but not yet
   wired into loaders.

Reference resolver — `sh`:

    xenv_bin() {
      [ -n "${XENV_BIN:-}" ] && { printf '%s\n' "$XENV_BIN"; return 0; }
      [ -x ./xenv/bin/xenv ]  && { printf '%s\n' ./xenv/bin/xenv; return 0; }
      command -v xenv 2>/dev/null && return 0
      return 1
    }

Reference resolver — `python`:

    import os, shutil
    def xenv_bin():
        b = os.environ.get("XENV_BIN")
        if b: return b
        if os.access("xenv/bin/xenv", os.X_OK): return "xenv/bin/xenv"
        return shutil.which("xenv")   # None if absent

## Probe capabilities

    xenv version --json
    → {"tool":"xenv","version":"…","wire_read":["v3","v4","v5"],
       "wire_write":"v5","kdf":"pbkdf2-sha256","kdf_expand":"hkdf-sha256",
       "cipher":"aes-256-cbc","padding":"pkcs7","mac":"hmac-sha256",
       "features":["run","json","json-base64","dotenv","xenv-loaded",
                   "sole-env","xenv-env"]}

Negotiate from `wire_read` / `features` instead of guessing. Schema is
add-only (stable). Needs no crypto — works even where openssl is missing.

## Load an env

    xenv @<env> --json          # {"KEY":"value"} — text/UTF-8 ONLY
    xenv @<env> --json-base64   # {"KEY":"<base64>"} — binary-safe; decode each value
    xenv @<env> CMD [args]      # exec CMD with the env injected; nothing hits disk

`--json` cannot represent raw/non-UTF-8 bytes — use `--json-base64` for
keyfiles / binary tokens (same flat shape, every value base64; the endpoint
is the convention, so decode all values; empty value → `""`).

`xenv run` and the `@<env> CMD` shorthand also export **`XENV_LOADED=<env>`**:
read it to answer "am I under a loaded vault, and which one?" — do NOT sniff
for a specific key like `DATABASE_URL`. `$XENV_LOADED` is an OUTPUT set by
xenv; `$XENV_ENV` is an INPUT (which env to resolve). If `$XENV_LOADED`
disagrees with the app's own `APP_ENV`, that is a real config mismatch.

Do NOT read `.value.enc` files directly or reimplement crypto when the binary
is present. Do NOT decrypt to a plaintext file you might `git add`.

## Passphrase — environment only

    $XENV_KEY_<ENV>   e.g. $XENV_KEY_PRODUCTION   (env name upper, - → _)
    $XENV_KEY         project-wide fallback

Read it from the environment; never seek a key on disk, print it, or write it
into the repo. Writing secrets (`set`/`edit`/`rotate`) is a human/CI action;
loaders are read-only by design.

## Verify / spec

- Wire format + KDF: `recipes/README.md`.
- Conformance vectors: `recipes/vectors/vectors.json` + `verify.rb` /
  `verify.js` — a language-neutral oracle. Port ~20 lines of decrypt and run
  it against the JSON to prove a loader is byte-correct.

The `XENV_` prefix is reserved — never set your own `XENV_*` variable names.
