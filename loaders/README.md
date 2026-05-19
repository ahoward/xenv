# loaders

Read-only loaders for the xenv format in three languages — proof that the format is portable and the pitch in the project README ("xenv is a convention plus a shell wrapper") is real.

All three loaders were generated from [`AGENT_PROMPT.md`](AGENT_PROMPT.md). Feed that file to any coding agent and you should get an equivalent loader in the target language. The checked-in implementations are reference outputs, not additional spec.

## status

```sh
loaders/test.sh         # exercise all three loaders against a real vault
```

The test rig builds a sandbox `xenv/` tree with known plaintexts, then invokes each loader's CLI and asserts:

1. `load(env)` round-trips every value
2. `decrypt_one(env, key)` matches `load(env)[key]`
3. tampered envelopes are rejected (MAC verification fails before decrypt)

A loader is skipped if its runtime isn't installed.

## what each loader exposes

| | importable | CLI |
|---|---|---|
| **pythong/xenv.py** | `from xenv import load, decrypt_one` | `python3 xenv.py <env> [<key>]` |
| **node/xenv.js**    | `const { load, decryptOne } = require('./xenv.js')` | `node xenv.js <env> [<key>]` |
| **go/xenv.go**      | `import "xenv-loader-go/xenv"` | `go run ./main <env> [<key>]` |

All three look for the encrypted tree at `$XENV_ROOT` (default `./xenv/`) and read the passphrase from `$XENV_KEY_<ENV>` or `$XENV_KEY`. No file-based / keychain / `pass` fallback — that's the shell tool's job. The realistic deployment path is "container reads `$XENV_KEY_PRODUCTION` injected by the platform's secret manager."

## crypto choices

- **pythong**: stdlib `hashlib.pbkdf2_hmac` + `hmac`. AES-CBC via `openssl(1)` subprocess (stdlib has no AES). Swap to `cryptography` if you already depend on it.
- **node**: pure stdlib `crypto`. Zero deps.
- **go**: stdlib `crypto/*` + `golang.org/x/crypto/pbkdf2` (well-known x/crypto subrepo).

## adding a new language

1. Read [`AGENT_PROMPT.md`](AGENT_PROMPT.md). It's self-contained — it doesn't reference `bin/xenv` for spec, only for the tiebreaker on ambiguity.
2. Write your loader. Match the CLI contract: `<runtime> <loader> <env> [<key>]`.
3. Add a stanza to `loaders/test.sh` that calls `exercise "<name>" <runtime> <loader-path>`. The test rig handles the rest.
4. Run `loaders/test.sh`. If it passes, send a PR.

The bar isn't "production-grade SDK" — it's "10–60 lines that prove the format is portable." Resist the urge to add config-file support, passphrase resolvers, encrypt operations, or a flag parser. Those go in the *tool*, not the loader.
