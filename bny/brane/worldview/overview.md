# xenv Overview
A zero-dependency environment runner and secrets manager compiled as a static binary from Bun/TypeScript.

## Vision

xenv combines the execution model of `senv`, the encrypted vault philosophy of `sekrets`, and modern packaging from `dotenvx` into a single, statically linked binary with sub-millisecond startup.

## Core Problems Solved

- **Syntax pollution** — verbose flags and wrapper scripts in existing tools
- **Platform collisions** — hosting platforms (Vercel, Netlify, Heroku) choke on encrypted strings in `.env` files
- **Dependency hell** — existing tools require Node.js, Ruby, or Python on the host

## Key Differentiators

| Feature | Detail |
|---|---|
| `@` syntax | Clean execution wrapper: `xenv @production -- ./server` |
| `.xenv` extension | Bypasses platform parsers while staying `.env`-compatible |
| Zero dependencies | Single static binary — works in Alpine, CI, anywhere |
| Native encryption | AES-256-GCM integrated without external KMS |
