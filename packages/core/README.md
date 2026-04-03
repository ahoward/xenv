# @xenv/core

Programmatic xenv — load encrypted `.xenv` vaults without the CLI binary. Zero dependencies.

The library equivalent of `require('dotenv').config()`, but with AES-256-GCM encryption, a 7-layer cascade, and `~/.xenv.keys` global keyfile support.

## install

```bash
npm install @xenv/core
# or
bun add @xenv/core
# or
pnpm add @xenv/core
```

## usage

```typescript
import { loadEnv } from "@xenv/core";

// load and resolve the 7-layer cascade
const env = await loadEnv("production");
console.log(env.DATABASE_URL);
```

### inject into process.env

```typescript
import { loadEnv } from "@xenv/core";

// like dotenv — writes to process.env
await loadEnv("production", { inject: true });
// process.env.DATABASE_URL is now set

// don't overwrite existing env vars
await loadEnv("production", { inject: true, override: false });
```

### custom working directory

```typescript
const env = await loadEnv("staging", { cwd: "/path/to/project" });
```

## what it resolves

The 7-layer cascade, same as the xenv CLI:

| layer | source | example |
|---|---|---|
| 1 | `.env` | legacy base defaults |
| 2 | `.xenv` | modern base defaults |
| 3 | `.env.local` / `.xenv.local` | developer-local overrides |
| 4 | `.env.{env}` / `.xenv.{env}` | environment-specific plaintext |
| 5 | `.xenv.{env}.enc` | encrypted vault (decrypted in memory) |
| 6 | `.env.{env}.local` / `.xenv.{env}.local` | local overrides per environment |
| 7 | `process.env` | system env always wins |

Keys are resolved from: env vars → project `.xenv.keys` → `~/.xenv.keys` (with `# root:` directory scoping).

## lower-level exports

```typescript
import {
  parseEnvContent,    // parse .env/.xenv file content
  encryptContent,     // AES-256-GCM encrypt
  decryptContent,     // AES-256-GCM decrypt
  decryptVault,       // decrypt a vault file
  resolveKey,         // resolve encryption key (8-step lookup)
  resolveCascade,     // resolve layers 1-6 without system env merge
} from "@xenv/core";
```

## requirements

- Node.js 18+ (uses `crypto.subtle` for AES-256-GCM)
- Also works with Bun and Deno

## license

MIT — [mountainhigh.codes](https://mountainhigh.codes) / [drawohara.io](https://drawohara.io)
