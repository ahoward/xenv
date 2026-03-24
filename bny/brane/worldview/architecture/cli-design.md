# CLI Design
The interface prioritizes execution speed, transparent standard streams, and proper exit code forwarding.

## Syntax

```bash
# Explicit environment
xenv @production -- ./server

# Implicit (defaults to @development or @local)
xenv -- bun run dev
```

## Process Model

- Uses `Bun.spawn()` for child process execution
- Signals (SIGINT, SIGTERM) cleanly inherited and forwarded
- TTY properties preserved
- Exit codes mapped transparently
- stdin/stdout/stderr passed through
