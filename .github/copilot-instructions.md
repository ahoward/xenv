# xenv — AI-native secrets manager

See [AGENTS.md](../AGENTS.md) for full project guide: commands, code style, architecture, testing, security rules.

## Quick reference

- `xenv init` — bootstrap xenv in a project
- `xenv @env -- command` — run with resolved environment
- `xenv edit @env set KEY=VALUE` — atomic secret set (zero-disk)
- `xenv audit --json` — security scan
- All commands support `--json` for machine-readable output

## MCP server

`xenv mcp` starts a JSON-RPC 2.0 MCP server over stdio with 13 tools for secrets management. Call `doctor` first to check project health.

## Security

- NEVER commit `.xenv.keys`
- NEVER `git add .` — always add specific files
- NEVER include key values in output
