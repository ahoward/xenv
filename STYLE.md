# TypeScript style — ahoward

> **Every choice in this guide optimizes for the reader, not the writer.** When in doubt, choose the version that the next person — or you, six months from now — will understand faster.

A personal style guide for TypeScript code. Optimized for **readability when scanning fast**. The goal is code that reads more like Ruby or Python than like Java.

This guide applies to any TypeScript codebase ahoward (or AI agents working on his behalf) writes or maintains.

---

## the prime directives

1. **Optimize for the reader.** Longer descriptive names, predictable structure, named operations. Generosity to the reader is the deepest principle — every other rule serves this one.
2. **`namespace.method()` reads better than `oneLongCamelCase()`.**
3. **Less ceremony, fewer keywords, shorter signatures.**
4. **Types are documentation — keep them out of the way of the code.**
5. **Snake_case for code, PascalCase for types.**
6. **POD only — no classes for data containers.**
7. **One word per concept, used everywhere.**

If a rule below contradicts these, the prime directives win.

---

## imports

**Default to namespace imports.**

```typescript
// YES
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

if (fs.existsSync(p)) { ... }
const dir = path.join(cwd, "build");

// NO
import { existsSync } from "node:fs";
import { join } from "node:path";

if (existsSync(p)) { ... }
const dir = join(cwd, "build");
```

**Why:** `fs.existsSync` carries provenance — you know where the function came from without scrolling to the import block. `existsSync` could be from anywhere. Code reads better when call sites tell you what kind of operation is happening (filesystem vs path vs network vs business logic).

**For local modules**, namespace-import too:

```typescript
// YES
import * as vault from "./vault";
import * as parse from "./parse";

const data = parse.env_content(content);
const key = vault.resolve_key(env, cwd);

// NO
import { parseEnvContent } from "./parse";
import { resolveKey } from "./vault";
```

**Exception:** types and constants are fine to pull directly. They aren't called, and `vault.VAULT_HEADER` reads awkwardly (namespace dot SCREAMING).

```typescript
import type { Env, Cwd } from "./types";
import { VAULT_VERSION } from "./vault";
```

**Operational tradeoffs to know about:**

- **Tree-shaking** is fine for ESM stdlib. For massive CommonJS libraries (`lodash`, `aws-sdk` v2), namespace import can defeat tree-shaking. For those specific libs, prefer subpath imports (`import map from "lodash/map"`).
- **Convention clash:** the rest of the TypeScript world uses named imports. Stack Overflow, library docs, AI-generated code. Onboarding cost is real.
- **IDE auto-import** defaults to named in VSCode/Cursor. Configure your linter (Biome `useNamingConvention`, ESLint `import/no-named-default`) to enforce, or just train yourself to retype the import.
- **Type-only:** with `verbatimModuleSyntax: true`, namespace imports of types need `import type * as T from "..."`.

When in doubt, namespace.

---

## naming

### snake_case for runtime identifiers

```typescript
// YES
const env_name = "production";
const file_path = path.join(cwd, ".env");
function resolve_key(env: string, cwd: string) { ... }
function parse_env_content(content: string) { ... }

// NO
const envName = "production";
const filePath = path.join(cwd, ".env");
function resolveKey(env: string, cwd: string) { ... }
function parseEnvContent(content: string) { ... }
```

**Why:** `parse_env_content` reads as three words. `parseEnvContent` reads as one mashed word your eye has to decode. Snake_case wins for prose-like code.

**Operational tradeoffs to know about:**

- **React/JSX** is camelCase and non-negotiable (`onClick`, `tabIndex`, `className`, `useState`, `useEffect`). Frontend work means living in two casings.
- **JSON APIs** preserve keys — Stripe, GitHub, AWS all return camelCase. You can't rename in destructure without `:` aliasing.
- **Schema/ORM libs** — zod, Drizzle, Prisma, tRPC, GraphQL codegen all default to camelCase and may produce camelCase types you can't rename without codegen config.
- **Linter defaults** flag snake_case. Configure `@typescript-eslint/naming-convention` or Biome's `useNamingConvention`.

**The boundary translation pattern:** keep external shapes external, snake_case internal:

```typescript
// at the boundary — accept what the API gives
type StripeCustomer = { id: string; emailAddress: string; createdAt: number };

async function fetch_customer(id: string): Promise<Customer> {
  const raw: StripeCustomer = await stripe.customers.retrieve(id);
  // translate at the boundary, once
  return {
    id: raw.id,
    email: raw.emailAddress,
    created_at: raw.createdAt,
  };
}

// internal type uses snake_case
type Customer = { id: string; email: string; created_at: number };
```

The translation is a one-time cost per boundary. Internal code stays clean.

**Predicate functions** are an exception — `is_*`, `has_*`, `can_*`, `needs_*` are adjectival and read better than verb form. `is_set`, `has_key`, `needs_quoting` — keep them.

### PascalCase for types

```typescript
// YES
type Env = Record<string, string>;
type EditResult = { env: string; action: "set" | "deleted"; key: string };
interface VaultOptions { cwd: string; force: boolean; }

// NO
type env = Record<string, string>;
type edit_result = ...;
```

### SCREAMING_SNAKE_CASE for constants

```typescript
const VAULT_HEADER = "xenv:v1:";
const KEY_LENGTH = 32;
const DEFAULT_ENV = "development";
```

### Verbs for functions, nouns for data

```typescript
// good
function encrypt_content(plaintext: string, key: string): string { ... }
const result = { env, key, action };

// bad
function encryption(plaintext: string, key: string): string { ... }  // sounds like a noun
const encrypter = { ... };  // sounds like a class
```

### names describe the thing, not the type

A name should answer "what is this?" not "what type is this?". The latter is a label; the former is information.

```typescript
// YES — tells the reader what the value is
const decrypted_plaintext = await vault.decrypt(blob, key);
const staged_files = git.staged();
const home_keys = read_global_keys_file();

// NO — the reader still has to figure out what it is
const data = await vault.decrypt(blob, key);
const arr = git.staged();
const obj = read_global_keys_file();
```

If you reach for `data`, `value`, `result`, `tmp`, `obj`, or `helper` as a name, you haven't yet decided what the value *is*. Keep going.

**Exception:** `result` is acceptable as a return-value local in a function whose entire purpose is *to compute that one thing*. `tmp` is acceptable for a single-line scratch value. Both should be rare.

### no `and`/`or`/`with`/`then` in function names

If a function name needs a conjunction, it's two functions. Composition belongs at the call site, not in the name.

```typescript
// NO — name confesses two responsibilities
async function decrypt_and_parse_vault(path: string, key: Key): Promise<Env>
function validate_and_save(data: Env): void
function load_or_init(path: string): Config

// YES — composition is visible at the call site
const plaintext = await vault.decrypt(path, key);
const env = parse.env_content(plaintext);

// YES — use a different word that captures the whole operation
function commit(data: Env): void  // implies validate-then-save
function open(path: string): Config  // implies load-or-init
```

### function-name prefixes are contracts

Common prefixes carry expectations. Don't violate them — readers rely on them.

| prefix | contract |
|---|---|
| `is_*`, `has_*`, `can_*`, `needs_*` | returns `boolean`, no side effects |
| `get_*` | read-only access to existing state |
| `set_*` | write-only, doesn't return the value being set |
| `parse_*` | pure transformation, no I/O |
| `format_*` | returns a string for display |
| `load_*` | does I/O (filesystem, network) |
| `save_*` | does I/O, writes |
| `make_*`, `build_*`, `create_*` | constructs and returns a new value |
| `assert_*` | throws if the condition fails, returns nothing |
| `require_*` | throws if missing, returns the value |
| `try_*` | returns `null` or a fallback on failure instead of throwing |

```typescript
// YES — prefix matches behavior
function is_secret(value: string): boolean { ... }
function load_vault(path: string): Promise<Env> { ... }
function require_key(env: string): string { ... }
function try_resolve_key(env: string): string | null { ... }

// NO — violates the contract
function is_valid(input: string): string { return input.trim(); }  // "is_*" must be boolean
function get_config(path: string): Config { fs.writeFileSync(...); return ... }  // "get_*" doesn't write
```

### one word per concept

Pick one term per concept and use it everywhere. Mixing `env` / `env_name` / `name` / `environment` for the same idea fragments the codebase and makes grep useless.

```typescript
// YES — one term, used consistently
function resolve_key(env: string): string | null { ... }
function load_vault(env: string): Promise<Env> { ... }
function encrypt(env: string, plaintext: string): string { ... }

// NO — three names for one concept
function resolveKey(env_name: string): string | null { ... }
function loadVault(name: string): Promise<Env> { ... }
function encrypt(environment: string, plaintext: string): string { ... }
```

For codebases with multiple concepts that *could* share a name, pick canonical terms early and qualify the less common one. For xenv: `key` always means the encryption key. If you also need a record key in the same scope, the record key gets a qualifier (`record_key`) — never the encryption key.

A short glossary at the top of `AGENTS.md` (or the README) is helpful for projects with non-obvious vocabulary.

---

## types

### type aliases over inline types

If a type is used twice, name it.

```typescript
// YES
type Env = Record<string, string>;
function load_env(name: string): Promise<Env> { ... }
function merge(a: Env, b: Env): Env { ... }

// NO
function load_env(name: string): Promise<Record<string, string>> { ... }
function merge(a: Record<string, string>, b: Record<string, string>): Record<string, string> { ... }
```

### types live with their data

Types belong next to the code that owns them. A `vault.ts` exports its `VaultOptions` type. Don't pre-emptively centralize.

A shared `types.ts` is fine ONLY for types used across many modules with no obvious owner (e.g. a `Cwd = string` alias used everywhere). Don't create one for "all the types in the project."

### `type`, not `interface`

`type` works everywhere `interface` does, plus unions, intersections, and mapped types. One keyword, less noise.

```typescript
// YES
type EditResult = { env: string; action: "set" | "deleted"; key: string };

// NO
interface EditResult { env: string; action: "set" | "deleted"; key: string }
```

**Only exception:** declaration merging for global augmentation (rare).

**Tradeoff to know about:** TS team officially recommends `interface` for object shapes (slightly better error messages, marginal compile perf). I find the readability cost of mixing keywords worse than the marginal benefit. One keyword.

### avoid generics in application code

Generics are powerful but visually heavy. Application code rarely needs them — use concrete types.

```typescript
// over-engineered
function pluck<T, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> { ... }

// just use the concrete types
function pluck(env: Env, keys: string[]): Env { ... }
```

**Library/SDK code is different** — generics earn their keep when the function genuinely operates over arbitrary shapes (parsers, serializers, DI containers, generic data structures). Use them deliberately, not reflexively.

### no `any`. ever.

Use `unknown` and narrow.

```typescript
// YES — narrow at the use site
function read_count(value: unknown): number {
  if (typeof value !== "number") throw new Error(`expected number, got ${typeof value}`);
  return value;
}

// NO — gives up
function read_count(value: any): number {
  return value;
}
```

For untrusted shapes, use a schema validator (zod, valibot) instead of writing narrowing helpers by hand.

### `as` casts only at boundaries

`JSON.parse` returns `any`. Type the boundary as `unknown`, validate, then narrow.

```typescript
// YES — JSON parsed as unknown, validated, then used as the real type
const raw: unknown = JSON.parse(body);
if (!is_user_payload(raw)) throw new Error("invalid user payload");
return raw; // narrowed to UserPayload by the type guard

// or with zod
const user = UserSchema.parse(JSON.parse(body)); // throws on shape mismatch

// NO — `as` lies to the compiler with no runtime check
const user = JSON.parse(body) as User;
```

---

## functions

### arrow functions for one-liners

```typescript
// YES
const is_set = (v: string | undefined): v is string => v !== undefined;
const sum = (a: number, b: number) => a + b;

// also OK but heavier for one-liners
function is_set(v: string | undefined): v is string {
  return v !== undefined;
}
```

### `function` keyword for multi-line procedures

```typescript
// YES — multi-step, named, hoisted, debuggable in stack traces
function resolve_key(env: string, cwd: string): string | undefined {
  const specific = `XENV_KEY_${env.toUpperCase()}`;
  if (process.env[specific]) return process.env[specific];
  // ...
  return undefined;
}

// less good — arrow makes the function feel inline-y
const resolve_key = (env: string, cwd: string): string | undefined => {
  // ...
};
```

**Rule of thumb:** if it has more than one statement OR is exported, use `function`. If it's a single expression returned from a `.map`/`.filter`/etc, use `=>`.

### default to `async` only when needed

If a function never awaits, it shouldn't be `async`. Don't paint everything async out of habit.

### keep signatures short

```typescript
// YES — short signature, options object for complex configs
function spawn_editor(file: string, opts: SpawnOpts = {}) { ... }

// NO — six positional parameters
function spawn_editor(file: string, editor: string, env: Env, cwd: string, timeout: number, signal: AbortSignal) { ... }
```

### one job per function

If a function does decryption AND parsing AND validation, split it. Smaller functions read better and test better.

```typescript
// NO — three concerns in one function
async function load_and_validate(path: string, schema: Schema) {
  const raw = await fs.readFile(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (!schema.is_valid(parsed)) throw new Error("invalid");
  return parsed;
}

// YES — three concerns, three functions, one composition
const read = (p: string) => fs.readFile(p, "utf-8");
const parse_json = (s: string) => JSON.parse(s) as unknown;
const validate = (data: unknown, schema: Schema) => {
  if (!schema.is_valid(data)) throw new Error("invalid");
  return data;
};

async function load(path: string, schema: Schema) {
  return validate(parse_json(await read(path)), schema);
}
```

### no overloads in application code

Function overloads are for libraries. In application code, use union types or separate functions.

---

## control flow

### early returns over nested ifs

```typescript
// YES
function load(path: string) {
  if (!fs.existsSync(path)) return null;
  if (!is_readable(path)) return null;
  return fs.readFileSync(path, "utf-8");
}

// NO
function load(path: string) {
  if (fs.existsSync(path)) {
    if (is_readable(path)) {
      return fs.readFileSync(path, "utf-8");
    }
  }
  return null;
}
```

### regex over chained `.includes()`

```typescript
// YES
const NEEDS_QUOTING = /[\s"'`#]|^$/;
const needs_quoting = (v: string) => NEEDS_QUOTING.test(v);

// NO
function needs_quoting(v: string) {
  if (v.length === 0) return true;
  if (v.includes(" ")) return true;
  if (v.includes("\n")) return true;
  if (v.includes("\t")) return true;
  if (v.includes('"')) return true;
  // ...
}
```

### prefer expression form

```typescript
// YES — single expression
const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vim";

// NO — five lines for the same idea
let editor: string;
if (process.env.EDITOR) {
  editor = process.env.EDITOR;
} else if (process.env.VISUAL) {
  editor = process.env.VISUAL;
} else {
  editor = "vim";
}
```

### use `??` not `||` for default values

`||` treats `""` and `0` as missing. `??` only fires on `null`/`undefined`. Use `??`.

### array methods over imperative loops

```typescript
// YES
const sorted_keys = Object.keys(data).sort();
const lines = sorted_keys.map(k => `${k}=${data[k]}`);
return lines.join("\n");

// NO
const sorted_keys = Object.keys(data);
sorted_keys.sort();
const lines: string[] = [];
for (const k of sorted_keys) {
  lines.push(`${k}=${data[k]}`);
}
return lines.join("\n");
```

But `for (const x of xs)` is fine when you need `break`/`continue`/`await` in the loop body.

---

## data

### POD only

No classes for data containers. Use plain objects with type aliases.

```typescript
// YES
type EditResult = { env: string; action: "set" | "deleted"; key: string };
const result: EditResult = { env, action: "set", key };

// NO
class EditResult {
  constructor(public env: string, public action: "set" | "deleted", public key: string) {}
}
```

Classes are for things with behavior (state machines, parsers, sockets). Data is data.

### `Object.create(null)` for dictionaries from untrusted input

When building maps from untrusted input (env files, JSON, user input), `Object.create(null)` avoids prototype pollution.

```typescript
const env: Record<string, string> = Object.create(null);
```

**But:** if you then `Object.assign(env, untrusted)` or spread `{...env, ...untrusted}` from a polluted source, the protection is gone. Validate keys with an allowlist (regex, set membership) regardless. `Object.create(null)` is one belt; key validation is the other.

### prefer `null` over `undefined` for absence

When a value is *intentionally* absent, return `null`. Reserve `undefined` for "not set yet."

```typescript
// YES
function find_key(env: string): string | null { ... }

// less good
function find_key(env: string): string | undefined { ... }
```

JS/TS makes this messy because `Map.get` returns `undefined`, optional fields are `T | undefined`, JSON serialization drops `undefined`, etc. Don't fight it everywhere — but when *you* design a return type, prefer `null`.

**Tradeoff to know about:** the wider TS community leans the other way — most teams pick `undefined` because it composes with optional fields and JSON. This is a deliberate choice to favor explicit absence ("I checked, the answer is nothing") over implicit absence ("I didn't set anything"). If you find yourself constantly translating between the two, your boundary discipline is wrong, not the rule.

---

## strings

### template literals for interpolation

```typescript
// YES
const path = `${cwd}/.xenv.${env}.enc`;

// NO
const path = cwd + "/.xenv." + env + ".enc";
```

### quote priority: backticks → double → never single

1. Backticks for interpolation, multiline, or strings containing `"`.
2. Double quotes for everything else. They match JSON.
3. Single quotes — never.

```typescript
// YES
const name = "production";
const path = `${cwd}/.xenv.${env}.enc`;
const html = `<a href="${url}">click</a>`;

// NO
const name = 'production';
```

### multiline with template literals, not concatenation

```typescript
// YES
const msg = `
  encryption key not found: ${key_env}
  run 'xenv keygen @${env}' to generate one
`.trim();

// NO
const msg = "encryption key not found: " + key_env + "\n" +
            "run 'xenv keygen @" + env + "' to generate one";
```

---

## errors

### throw `Error` with helpful messages

```typescript
// YES
throw new Error(`vault not found: .xenv.${env}.enc — run 'xenv encrypt @${env}' to create it`);

// NO
throw new Error("vault not found");
throw "vault not found";  // never throw non-Error
throw { code: 404 };       // never throw plain objects
```

Error messages are UI. Tell the reader what's wrong AND what to do about it.

### custom error classes only when callers discriminate

```typescript
// YES — caller will catch DecryptionError specifically
class DecryptionError extends Error {}
class KeyNotFoundError extends Error {}

try {
  await load_vault(env);
} catch (e) {
  if (e instanceof KeyNotFoundError) {
    return prompt_for_key();
  }
  throw e;
}

// NO — never caught with instanceof, just adds noise
class GenericVaultError extends Error {}
```

### preserve cause when re-throwing

When wrapping an error to add context, pass `cause` so the original stack survives.

```typescript
// YES
try {
  await crypto.decrypt(blob, key);
} catch (e) {
  throw new Error(`vault decryption failed for @${env}`, { cause: e });
}

// NO — original error and stack lost
try { ... } catch (e) {
  throw new Error("decryption failed");
}
```

### no `.catch()` swallowing

```typescript
// NO — silently throws away errors
try { do_thing(); } catch {}

// YES — at least log
try { do_thing(); } catch (e) { console.error("do_thing failed:", e); }

// YES — when intentional cleanup
try { fs.unlinkSync(tmp); } catch {} // ok: best-effort cleanup
```

If you swallow, comment why.

---

## async

### `async`/`await`, not `.then()` chains

Promise chains read worse than `await`. The only place `.then()` makes sense is when the callback is one expression and breaking the line would hurt readability.

```typescript
// YES
const data = await fetch(url).then(r => r.json());

// also YES
const response = await fetch(url);
const data = await response.json();

// NO
return fetch(url).then(response => {
  return response.json().then(data => {
    return process(data);
  });
});
```

### parallelize with `Promise.all` when work is independent

```typescript
// YES — runs in parallel
const [user, posts, settings] = await Promise.all([
  fetch_user(id),
  fetch_posts(id),
  fetch_settings(id),
]);

// NO — serializes for no reason
const user = await fetch_user(id);
const posts = await fetch_posts(id);
const settings = await fetch_settings(id);
```

But sequential is right when later calls depend on earlier ones, or when you need ordered side effects.

### accept `AbortSignal` for anything cancellable

Long-running ops (HTTP, file watching, child processes) should accept an optional `signal: AbortSignal`. Even if you don't use it now, callers can compose cancellation later.

### never leave promises floating

Every promise must be `await`ed, returned, or explicitly fired-and-forgotten with a comment.

```typescript
// YES
await save();
return save();
void save(); // intentional fire-and-forget — caller doesn't wait

// NO — silently swallowed
save();
```

---

## CLI patterns

### stdout is data, stderr is everything else

```typescript
// YES — JSON goes to stdout, status messages to stderr
console.log(JSON.stringify(result));         // pipeable
process.stderr.write("encrypted → vault\n"); // status

// NO — pollutes stdout, breaks piping
console.log("encrypted → vault");
console.log(JSON.stringify(result));
```

The rule: anything a downstream tool would parse goes to stdout. Anything a human reads goes to stderr.

### exit codes are part of the contract

```typescript
// 0 = success, 1 = generic error, 2 = usage error
if (validation_failed) process.exit(1);
if (bad_args) process.exit(2);
```

### `--json` everywhere

If the human format is a table, the JSON form is an array of objects. Both come from the same internal data. Don't render the human format and parse it back to JSON.

### parse args explicitly

For non-trivial CLIs, write your own arg parser or use a small library (`mri`, `cac`). Avoid heavy frameworks (`commander`, `yargs`) unless you need their full surface — they add weight and mask errors.

---

## testing

### colocate tests with source

```
src/
  parse.ts
  parse.test.ts
  vault.ts
  vault.test.ts
```

NOT a parallel `test/` tree mirroring `src/`. Tests are part of the unit they test.

### use the test runner that ships with your runtime

- Bun: `bun:test`
- Node 20+: `node --test`
- Otherwise: `vitest`

Skip Jest unless you're stuck with it. It's slow and has compatibility friction with ESM/TS.

### test the public API, not implementation

Each test should call exported functions, not internal helpers.

```typescript
// YES — calls the public function
test("parses KEY=value", () => {
  expect(parse_env_content("FOO=bar")).toEqual({ FOO: "bar" });
});

// NO — tests an internal helper that may be refactored away
test("expand_escapes works", () => {
  expect((parser as any)._expand_escapes("\\n")).toBe("\n");
});
```

### no mocks for things you own

Mock external systems (HTTP, file system, time). Don't mock your own code — restructure so the real code is testable directly.

### use real temp directories, not mocked filesystems

```typescript
// YES — real fs operations in a real temp dir
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "test-")); });
afterEach(() => { rmSync(tmp, { recursive: true }); });

// NO — mocked fs hides bugs in real fs interaction
mock("node:fs", { readFileSync: () => "fake" });
```

### one assertion per test, ideally

When a test has 8 assertions, it's really 8 tests. Splitting them gives clearer failure messages.

---

## logging

### no logger framework for CLIs

`console.error` and `process.stderr.write` are fine. Adding pino/winston to a CLI is overkill.

### structured logging for servers

For long-running services, use pino. Log JSON. Add a `request_id` field to every log line.

### never log secrets

Secrets, API keys, tokens, passwords, session IDs. Sanitize at log time.

```typescript
// YES
log.info({ user_id: user.id }, "user logged in");

// NO — full user object may contain hashed_password, session_token, etc.
log.info({ user }, "user logged in");
```

---

## comments

### default to no comments

Code with good names doesn't need comments. Save comments for the *why*.

```typescript
// YES — explains a non-obvious WHY
// WebCrypto appends the auth tag to the ciphertext, so we slice it off the end here
const tag = bytes.subarray(bytes.length - TAG_LENGTH);

// NO — restates what the code obviously does
// slice off the tag
const tag = bytes.subarray(bytes.length - TAG_LENGTH);
```

### no JSDoc on internal functions

JSDoc is for published library APIs. For internal code, types ARE the documentation.

```typescript
// NO — JSDoc on an internal helper is noise
/**
 * Get the editor command from the environment.
 * @returns The editor command, defaulting to vim.
 */
function get_editor(): string {
  return process.env.EDITOR ?? process.env.VISUAL ?? "vim";
}

// YES — name + signature is enough
function get_editor(): string {
  return process.env.EDITOR ?? process.env.VISUAL ?? "vim";
}
```

### TODO comments must include why and a path forward

```typescript
// YES
// TODO: switch to native crypto.subtle once Bun supports the SubtleCrypto.deriveKey overload (issue #1234)

// NO
// TODO: fix this
```

---

## file organization

### three regions, in this order

Every file has the same shape, top-to-bottom:

```typescript
// 1. PRELUDE — imports, types, constants
import * as fs from "node:fs";
import * as path from "node:path";

type Vault = { data: Env; key: Key };
const VAULT_HEADER = "xenv:v1:";

// ── public API ─────────────────────────────────────
// 2. PUBLIC — what callers use, in order of importance

export async function encrypt(plaintext: string, key: Key): Promise<Cipher> { ... }
export async function decrypt(cipher: Cipher, key: Key): Promise<string> { ... }

// ── helpers ────────────────────────────────────────
// 3. INTERNAL — not exported, in order of use

function pack_iv_ct_tag(iv: Bytes, ct: Bytes, tag: Bytes): Bytes { ... }
function unpack_iv_ct_tag(blob: Bytes): { iv: Bytes; ct: Bytes; tag: Bytes } { ... }
```

A reader knows exactly where to look:

- **Want to use this module?** Read the public section.
- **Want to understand how it works?** Read the helpers.
- **Want to know its dependencies?** Read the prelude.

The order of public functions matters too — most important / most frequently called first. Inverse pairs (encrypt/decrypt, save/load, install/uninstall) sit adjacent, with the "construct" side first.

### one concept per file

Each file has a single subject. `vault.ts` does vault stuff. `parse.ts` parses. `cli.ts` is the entry point. Don't mix.

### section dividers

When a file has multiple logical sections, separate with a simple comment:

```typescript
// ── parsing ──
// ── crypto ──
// ── helpers ──
```

Don't go heavy on ASCII art. If you need many dividers, the file is too long.

### long files are a smell

If a file is hard to navigate by scrolling, split it. The threshold is "can I find what I'm looking for fast?" not a hard line count.

---

## tooling

### Biome over ESLint+Prettier for new projects

Biome is faster, single-binary, no plugin hell. ESLint is fine for legacy projects.

### tsconfig: strict everything

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  }
}
```

`noUncheckedIndexedAccess` is the biggest one — it forces you to handle the case where `arr[i]` might be undefined. `verbatimModuleSyntax` enforces explicit `import type` for type-only imports.

### Biome config

```json
{
  "formatter": {
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always",
      "trailingCommas": "all"
    }
  }
}
```

### CI

Block merges on:
- `tsc --noEmit` (type errors)
- `biome check` (formatting + lint)
- `bun test` (unit tests)

A pre-commit hook for `biome format --write` is fine. Don't put `tsc` or full tests in pre-commit — they're too slow.

### Bun for new projects, Node for compat

Bun's APIs (`Bun.file`, `Bun.spawn`, `Bun.write`) are cleaner than Node's. When you're writing for Bun, prefer them.

---

## what I don't do

- **`fp-ts` / `Effect` / `ramda`** — abstractions that make TS less readable, not more.
- **Decorators** — magic action-at-a-distance, hurts grep-ability.
- **Function overloads** in application code.
- **`namespace` keyword** (the TS one, not import namespaces) — module is the unit.
- **`enum`** — use string literal unions: `type Status = "ok" | "fail"`.
- **`!` non-null assertion** — narrow with a check or use `??` instead.
- **`as const` everywhere** — only when the literal type is genuinely needed.
- **Configuration objects with 20 fields** — break them up or split the function.

---

## beauty

Rules get you to *clean*. These principles get you to *beautiful*. Beauty is the stage past correctness — when the code stops describing the computation and starts narrating it.

### code as prose

Each line is a sentence. Each function is a paragraph. Each file is a chapter. A reader should be able to skim a function top-to-bottom and understand what it does without parsing syntax.

```typescript
// not yet beautiful — eye has to compose meaning
async function load_vault(env: string, cwd: string) {
  const enc_path = path.join(cwd, `.xenv.${env}.enc`);
  if (!fs.existsSync(enc_path)) throw new Error(`vault not found: .xenv.${env}.enc`);
  const key = vault.resolve_key(env, cwd);
  if (!key) throw new Error(`encryption key not found: ${vault.key_env_names(env)}`);
  const plaintext = await vault.decrypt_vault(enc_path, key);
  const data = parse.env_content(plaintext);
  return { data, key };
}

// beautiful — reads as four sentences
async function load_vault(env: string, cwd: string) {
  const enc_path = vault_path(env, cwd);
  const key = require_key(env, cwd);
  const plaintext = await vault.decrypt(enc_path, key);
  return { data: parse.env_content(plaintext), key };
}
```

The transformation: each line names one operation. Validation gets a name (`require_key`). Path construction gets a name (`vault_path`). Only the irreducible composition (decrypt → parse) appears inline.

**Each line should be one named idea.** If a line has two operations, ask whether one of them deserves a name.

### symmetry

Inverse operations must look like inverses.

```typescript
// not symmetric — the eye can't see the pair
async function encrypt_content(plaintext: string, key: string): Promise<string>
async function decryptContent(blob: string, keyHex: string): Promise<string>

// symmetric — obvious they're inverses
async function encrypt(text: string, key: Key): Promise<Cipher>
async function decrypt(cipher: Cipher, key: Key): Promise<string>
```

Same naming pattern. Same parameter order. Same return shape (modulo the inverse).

When functions come in pairs (encode/decode, save/load, install/uninstall, lock/unlock, push/pop), make them visibly pair. Place them adjacent in the file. The reader who understands one understands the other.

### the function arc

Beautiful functions have shape: a beginning, a middle, an end.

```typescript
async function rotate_vault_key(env: string, cwd: string) {
  // 1. validate inputs and resolve dependencies
  const old_key = require_key(env, cwd);
  const enc_path = require_vault(env, cwd);

  // 2. do the work
  const plaintext = await vault.decrypt(enc_path, old_key);
  const new_key = vault.generate_key();
  const cipher = await vault.encrypt(plaintext, new_key);

  // 3. commit and return
  await fs.writeFile(enc_path, cipher);
  await write_key(env, new_key, cwd);
  return { env };
}
```

A blank line marks each transition. The middle is the longest. Preamble and coda are short.

If the middle has more than three distinct phases, the function is doing too much. Extract them into named helpers and call them from a slimmer top-level function. The top function then reads as a table of contents.

### errors at the boundary, never in the middle

Public functions check their inputs. Private helpers trust what's given.

```typescript
// not beautiful — every helper defends itself
function parse_env_name(input: string) {
  if (typeof input !== "string") throw new Error(...);
  if (input.length === 0) throw new Error(...);
  ...
}
function format_env_name(name: string) {
  if (typeof name !== "string") throw new Error(...);
  ...
}

// beautiful — boundary validates once, internals trust the contract
export function process(input: unknown): Output {
  if (typeof input !== "string") throw new Error("input must be a string");
  if (input.length === 0) throw new Error("input cannot be empty");
  return format_env_name(parse_env_name(input));
}

function parse_env_name(input: string) { /* trusts caller */ }
function format_env_name(name: string) { /* trusts caller */ }
```

Defensive programming inside private code is noise. The reader sees five `typeof` checks and assumes some have meaning. They don't. The boundary already did the work.

### tests as a spec

A test file should read like documentation. Each test name is a complete sentence describing a behavior. A reader should be able to scan the file and learn what the function does without ever looking at the implementation.

```typescript
describe("vault.decrypt", () => {
  test("round-trips with the same key", () => { ... });
  test("fails with the wrong key", () => { ... });
  test("rejects unknown vault versions", () => { ... });
  test("preserves multiline content", () => { ... });
});
```

If you can't write the test name as a sentence about behavior, you don't yet know what you're testing.

### negative space

What you don't write is part of the design.

- A blank line separates logical phases inside a function.
- An imported utility appears once, not three times.
- Small functions sit on one screen so the reader's eye doesn't lose its place.
- Files have a density that matches their purpose: config files dense, algorithm files sparse, glue files medium.

A function with no internal blank lines is either trivially short or insufficiently structured. A file with no blank lines between functions reads as one wall of code.

### the deepest principle

Every choice optimizes for the **reader**, not the writer.

- Names favor the reader (longer, descriptive, single-purpose).
- Structure favors the reader (predictable regions, top-to-bottom).
- Errors favor the reader (actionable, located at the boundary).
- Comments favor the reader (the *why*, never the *what*).
- Types favor the reader (named aliases, kept out of the way).
- Tests favor the reader (a spec, not a suite).

When you find yourself writing for the writer's convenience — a clever one-liner, a generic abstraction, a "this saves me typing" macro — stop. Beautiful code is generous to the reader.

---

## the test

When you can't decide between two ways to write something, ask: **"if a junior dev who knows Ruby/Python read this for the first time, would they understand it?"** If yes, keep it. If no, simplify.

A second test, for when the first feels insufficient: **"will I, six months from now, thank present-me for writing it this way?"**
