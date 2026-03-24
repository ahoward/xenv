# Roadmap
Three-phase plan from MVP runner through encryption vault to developer experience polish.

## Phase 1: Core Runner (MVP)

- [ ] CLI argument parsing — trap `@env` and `--`
- [ ] File resolution cascade and merging logic
- [ ] `Bun.spawn()` with transparent I/O and exit code mapping
- [ ] Cross-compilation CI matrix

## Phase 2: The Vault

- [ ] AES-256-GCM crypto integration
- [ ] `encrypt`, `decrypt`, `keys` commands
- [ ] In-memory decryption when `XENV_KEY_[ENV]` is detected during execution

## Phase 3: Developer Experience

- [ ] `xenv init` scaffolding
- [ ] Strict syntax validation with helpful error messages
- [ ] Documentation and binary distribution (Homebrew, npm, curl)
