# Product Requirements Document: `xenv`

**Version:** 1.0.0-draft
**Status:** In Design
**Author:** mountainhigh.codes

---

## 1. Overview & Vision
`xenv` is a blazing-fast, zero-dependency environment runner and secrets manager. Building on the elegant execution model of `senv`, the encrypted vault philosophy of `sekrets`, and modern packaging trends seen in `dotenvx`, `xenv` is designed for the modern runtime era. Written in Bun and distributed as a statically linked binary, it provides sub-millisecond startup times, native cryptography, and platform-agnostic secret management without the legacy bloat of standard interpreters.

## 2. Problem Statement
Managing environment variables and secrets across local development, CI/CD, and production platforms is fragmented.
* **Syntax Pollution:** Standard tools often pollute command lines with verbose flags or require complex wrapper scripts.
* **Platform Collisions:** Hosting platforms (like Vercel, Netlify, or Heroku) often attempt to parse `.env` files automatically, choking on the natively encrypted strings introduced by tools like `dotenvx`.
* **Dependency Hell:** Existing tools often require Node.js, Ruby, or Python to be present on the host or runner, complicating minimal Docker builds and CI pipelines.

## 3. Core Value Proposition
* **The `@` Syntax:** A clean, transparent execution wrapper that reads intent immediately (e.g., `xenv @production`).
* **Platform Safe (`.xenv`):** Introduces the `.xenv` file extension to bypass overzealous platform parsers while retaining full backwards compatibility with standard `.env` files.
* **Zero Dependencies:** Compiles down to a single, tiny, statically linked binary. Drop it in an Alpine container or a GitHub Action, and it just works.
* **Frictionless Encryption:** Symmetric AES-256-GCM encryption natively integrated without external KMS overhead.

---

## 4. Product Design & Architecture

### 4.1 CLI UX & Syntax
The interface prioritizes execution speed, transparent standard streams (`stdin`, `stdout`, `stderr`), and proper exit code forwarding.

* **Execution:**
  ```bash
  # Standard execution with explicit environment
  xenv @production -- ./server

  # Implicit execution (defaults to @development or @local)
  xenv -- bun run dev
  ```
* **Vault Management:**
  ```bash
  # Encrypt an environment into a vault
  xenv encrypt @production

  # Decrypt an environment for editing
  xenv decrypt @production

  # Generate a new secure key / keyfile
  xenv keys @production
  ```

### 4.2 The Environment Resolution Cascade
To prevent platform breakages while supporting legacy workflows, `xenv` merges files in a strict, deterministic order. Variables evaluated later in the cascade overwrite earlier ones.

| Order | File Format | Description | Source Control |
| :--- | :--- | :--- | :--- |
| **1** | `.env` | Legacy base defaults. | Committed |
| **2** | `.xenv` | Modern base defaults. | Committed |
| **3** | `.env.local` / `.xenv.local` | Developer-specific local overrides. | `.gitignore` |
| **4** | `.env.[env]` / `.xenv.[env]` | Environment-specific plaintext. | Committed |
| **5** | `.xenv.[env].enc` | Encrypted vault (decrypted in-memory). | Committed |
| **6** | `.env.[env].local` / `.xenv.[env].local` | Local testing overrides for a specific env. | `.gitignore` |
| **7** | **System `ENV`** | Standard process environment variables. | System-level |

*Note: If both a `.env` and `.xenv` exist at the exact same priority level, `.xenv` wins.*

### 4.3 Security & Encryption Model
Leveraging Bun's native `crypto` module ensures fast, secure cryptography.

* **Algorithm:** AES-256-GCM (Authenticated encryption).
* **Workflow:** Running `xenv encrypt @production` reads `.xenv.production` and generates `.xenv.production.enc`.
* **Key Injection:** Decryption keys are passed via the system environment (e.g., `XENV_KEY_PRODUCTION="hex_string"`). This is the only variable required in a CI/CD or PaaS dashboard.
* **Zero-Disk Policy:** During execution, `xenv` reads the `.enc` vault, decrypts it entirely in memory using the injected key, merges the variables, and passes them to the child process. Decrypted secrets are never written to disk.

---

## 5. Technical Implementation (Bun)

* **Runtime:** Bun (TypeScript).
* **Process Management:** Utilizes `Bun.spawn()` to execute the child process. This guarantees that signals (SIGINT, SIGTERM) and TTY properties are cleanly inherited and forwarded.
* **Parsing:** Custom, highly optimized regex/string parser for key-value extraction, prioritizing speed over AST complexity.
* **Compilation:**
  ```bash
  bun build ./src/cli.ts --compile --minify --target=bun-linux-x64 --outfile=xenv
  ```
  Cross-compiled via CI to target Linux (x64, arm64), macOS (x64, arm64), and Windows.

---

## 6. Milestones & Roadmap

### Phase 1: Core Runner (MVP)
- [ ] Implement robust CLI argument parsing to trap `@env` and `--`.
- [ ] Build the file resolution cascade and merging logic.
- [ ] Implement `Bun.spawn()` with transparent I/O and exit code mapping.
- [ ] Setup cross-compilation matrix in GitHub Actions.

### Phase 2: The Vault
- [ ] Implement the `crypto` module integration (AES-256-GCM).
- [ ] Build the `encrypt`, `decrypt`, and `keys` commands.
- [ ] Wire up in-memory decryption trigger when `XENV_KEY_[ENV]` is detected during standard execution.

### Phase 3: Developer Experience
- [ ] Implement `xenv init` to scaffold standard files and `.gitignore` entries.
- [ ] Add strict syntax validation and helpful error messaging for malformed `.xenv` files.
- [ ] Publish documentation and binary distribution channels (Homebrew, npm install script, curl bash script).
