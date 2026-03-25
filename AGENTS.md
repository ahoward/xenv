# xenv — agent guide

> Compatible with: Claude Code, Cursor, Windsurf, GitHub Copilot, Cline, Aider, Zed AI, Continue, RooCode, and any MCP-compatible tool.

AI-native environment runner and secrets manager. single binary. zero dependencies. AES-256-GCM encrypted vaults. 7-layer cascade. MCP server for AI tool integration.

## quick start

```bash
xenv init                                # bootstrap: gitignore, key, starter file
xenv encrypt @development               # encrypt the starter file
xenv @development -- your-command        # run with the resolved environment
```

## MCP server

register xenv as an MCP tool provider so you can manage secrets natively:

```bash
# Claude Code
claude mcp add xenv -- xenv mcp
```

```json
// Cursor, Windsurf, or Claude Desktop config:
{
  "mcpServers": {
    "xenv": {
      "command": "xenv",
      "args": ["mcp"]
    }
  }
}
```

MCP tools available: `init`, `resolve_env`, `set_secret`, `delete_secret`, `list_secrets`, `encrypt`, `diff`, `rotate_key`, `audit`, `validate`.

---

<!-- bny:start -->
## bny

you have `bny` available — a persistent knowledge graph and build factory.

commands:
- `bny digest <source>` — ingest file, URL, or directory into the knowledge graph
- `bny brane ask "question"` — query accumulated knowledge
- `bny brane tldr` — instant outline of what the graph knows
- `bny build "description"` — full pipeline: specify → plan → tasks → review → implement → ruminate
- `bny spike "description"` — exploratory build (no review)
- `bny proposal "topic"` — generate proposals from the graph

workflow:
- read `bny/state.md` if it exists — shows current build pipeline state
- tests are written by the antagonist agent — do NOT modify test files during implementation
- run `./dev/test` after code changes — all tests must pass
- run `./dev/post_flight` before commits
- read `bny/guardrails.json` for project constraints
- append to `bny/decisions.md` after completing work

knowledge graph:
- read `bny/brane/worldview/README.md` for accumulated project knowledge
- the worldview README is auto-regenerated after every brane operation

state lives in `bny/`. do not modify state files directly.
<!-- bny:end -->

---

## all commands

| command | description | example |
|---------|-------------|---------|
| `xenv [@env] -- cmd` | run a command with the resolved environment | `xenv @production -- ./server` |
| `xenv init [@env]` | bootstrap xenv in a project | `xenv init` |
| `xenv encrypt @env` | encrypt plaintext to vault | `xenv encrypt @production` |
| `xenv decrypt @env` | decrypt vault to plaintext | `xenv decrypt @production` |
| `xenv keygen @env` | generate an encryption key | `xenv keygen @production` |
| `xenv edit @env set K=V` | set a secret without decrypting to disk | `xenv edit @production set API_KEY=sk_live_...` |
| `xenv edit @env delete K` | remove a secret from vault | `xenv edit @production delete OLD_KEY` |
| `xenv edit @env list` | list vault key names (no values) | `xenv edit @production list --json` |
| `xenv resolve @env` | dump merged cascade | `xenv resolve @production --json` |
| `xenv diff @env` | compare plaintext vs vault | `xenv diff @production --keys-only` |
| `xenv validate @env` | pre-flight checks | `xenv validate @production --require DB_URL` |
| `xenv audit` | security scan | `xenv audit --json` |
| `xenv mcp` | start MCP server (stdio) | `xenv mcp` |

all commands support `--json` for machine-readable output.

## --json output schemas

| command | shape |
|---------|-------|
| `resolve --json` | `Record<string, string>` — flat key-value object |
| `edit set --json` | `{ env, action: "set", key }` |
| `edit delete --json` | `{ env, action: "deleted", key }` |
| `edit list --json` | `string[]` — sorted key names |
| `diff --json` | `{ env, added: [{key, ...}], removed: [...], changed: [...], unchanged: number }` |
| `validate --json` | `{ env, ok: boolean, checks: [{ severity, code, key?, message }] }` |
| `audit --json` | `{ ok: boolean, findings: [{ severity, code, file?, message }] }` |

## code style

- **functions/variables**: `snake_case` (e.g., `edit_set`, `resolve_env`)
- **types**: `PascalCase` (e.g., `DiffResult`, `ValidationCheck`)
- **constants**: `SCREAMING_SNAKE` (e.g., `VAULT_HEADER`, `KEY_LENGTH`)
- **data**: POD only — no classes for data containers. interfaces and type aliases only.
- **output**: all command output goes through `print_output()` from `src/output.ts`
- **null over undefined** where possible

## architecture

```
src/cli.ts          entry point, command dispatch
src/args.ts         CLI argument parsing (ParsedArgs)
src/parse.ts        .env/.xenv file parser (parseEnvContent)
src/resolve.ts      7-layer environment cascade (resolveEnv)
src/vault.ts        AES-256-GCM encryption, key management, .xenv.keys
src/edit.ts         atomic vault editing (edit_set, edit_delete, edit_list)
src/diff.ts         plaintext vs vault comparison
src/validate.ts     pre-flight environment checks
src/audit.ts        project security scanner
src/mcp.ts          MCP server (JSON-RPC 2.0 over stdio, 10 tools)
src/run.ts          child process execution with signal forwarding
src/output.ts       consistent human/JSON output formatting
src/init.ts         project bootstrapping (xenv init)
```

data flow: `cli.ts → args.ts (parse) → command module → output.ts (format)`

## testing

```bash
bun test              # run all tests
./dev/test            # same, via dev script
./dev/post_flight     # run before commits
```

- tests are written by the antagonist agent — **do NOT modify test files**
- tests call exported functions directly, not the CLI binary
- temp directories via `mkdtempSync` for file system isolation

## security rules

**you MUST follow these rules when working with this codebase:**

1. **NEVER** commit `.xenv.keys` — it contains encryption keys
2. **NEVER** include encryption key values in output, logs, diffs, or messages
3. **NEVER** read `.xenv.keys` unless performing xenv vault operations
4. **NEVER** `git add .` or `git add -A` — always add specific files
5. `.xenv.keys` **MUST** remain in `.gitignore` at all times
6. plaintext env files with matching vaults (`.xenv.production`, `.xenv.staging`) must be gitignored
7. `.xenv.*.enc` vault files are safe to commit — they are encrypted

## file layout

```
.xenv.keys                  encryption keys (gitignored, chmod 600)
.env                        legacy base defaults (committed)
.xenv                       modern base defaults (committed)
.xenv.production            prod plaintext (gitignored)
.xenv.production.enc        prod vault (committed, encrypted)
.xenv.staging               staging plaintext (gitignored)
.xenv.staging.enc           staging vault (committed, encrypted)
.xenv.development           dev config (committed, no secrets)
.xenv.local                 your machine only (gitignored)
.gitignore
```

## environment cascade (7 layers, later wins)

```
1. .env                         base defaults
2. .xenv                        modern base defaults
3. .env.local / .xenv.local     developer-local overrides
4. .env.{env} / .xenv.{env}     environment-specific
5. .xenv.{env}.enc              encrypted vault (decrypted in memory)
6. .env.{env}.local / ...       local overrides per environment
7. system ENV                   always wins
```
