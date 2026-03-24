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

## project guide

see [AGENTS.md](./AGENTS.md) for full project context: all commands, code style, architecture, testing, and security rules.
