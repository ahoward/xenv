# Changelog

All notable changes to xenv will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project
uses an informal semver-ish scheme tagged in `bin/xenv`'s `XENV_VERSION`.

The full audit trail of every change is in `git log` — this file is for
the changes that affect users.

## [0.9.0-posix] — 2026-05-23

**Breaking storage change.** Passphrase files now have a `.key` extension
and the resolver cascades from per-env to project-wide. Wire format
(envelopes, frontmatter) is unchanged; recipes are unaffected.

### Added

- **Project-wide `_global.key`.** Sits alongside per-env files at
  `~/.config/xenv/projects/<id>/keys/_global.key`. Any env without
  its own `<env>.key` cascades to it.

- **Cascade resolver** with 8 slots, env-specific beats global within
  each backend class:

      1. $XENV_KEY_<ENV>                env-specific env var
      2. $XENV_KEY                      project-wide env var
      3. keys/<env>.key                 env-specific file
      4. keys/_global.key               project-wide file
      5. keychain xenv/<id>/<env>       env-specific keychain
      6. keychain xenv/<id>/_global     project-wide keychain
      7. pass     xenv/<id>/<env>       env-specific pass
      8. pass     xenv/<id>/_global     project-wide pass

- **`xenv key <verb>` (no @env) operates on the project-wide key.**
  `generate`, `set`, `show`, `forget`, `rotate` all parallel the
  existing env-specific forms. Symmetric verb surface.

- **`xenv key rotate` (project-wide)** rotates `_global.key` and
  re-encrypts only envs that were using the global (Rule B: envs
  with their own per-env key are untouched). All-or-nothing: every
  env's values decrypt to a tmpfs stash before any commit.

- **`xenv key show @<env>` reports which cascade slot answered.**
  E.g. `file: …/_global.key (via _global fallback)` vs
  `file: …/production.key (env-specific)`. Lets you debug "why is
  this env getting this key?" in one command.

- **`xenv key forget` cascade hints.** Forgetting `_global` lists
  envs that lose their key as a result. Forgetting an env-specific
  key notes whether the env now cascades to `_global` or has no
  passphrase left at all.

### Changed

- **`xenv setup` default changed: ONE random global key by default.**
  Previously: four random per-env keys (one per default env).
  Now: one random `_global.key`, all four envs cascade to it.
  Rationale: matches the dominant-path use case (start with one key,
  split a specific env off later when it needs isolation). To get
  the old behavior, pin a `$XENV_KEY_<ENV>` per env at setup time.

- **Passphrase files now have a `.key` extension.** Old path was
  `~/.config/xenv/projects/<id>/keys/<env>` (no extension). New
  path is `keys/<env>.key`. Existing users must rename:

      cd ~/.config/xenv/projects/<id>/keys
      for f in *; do [ -f "$f" ] && [ "${f%.key}" = "$f" ] && mv "$f" "$f.key"; done

  No automatic migration. The audience is small enough that a
  manual one-liner is cleaner than a compat shim.

- **`xenv key rotate @<env>` semantics extended.** Still works the
  same when production already has its own key (rotate the per-env
  key, re-encrypt). When production was cascading to `_global`,
  `rotate @production` now writes a NEW `production.key`, splitting
  production off from the global. The rest of the project keeps
  using the global. This makes "I want to give production its own
  key now" a single command.

### Known limitation

- The project-wide `xenv key rotate` identifies "envs using
  `_global`" by checking only for the file backend's `<env>.key`.
  An env whose per-env key lives only in keychain or `pass` (without
  a corresponding file) would incorrectly be treated as
  global-using. For 0.9.0, document the limit; fix in a future
  release.

## [0.8.0-posix] — 2026-05-22

**Breaking release.** The verb surface is rewritten. No aliases, no
backcompat. Wire format and recipes are unchanged — only the way you
type commands changes. Anyone running their own scripts against the
old verbs will need to update them.

### Changed

- **`xenv init` → `xenv setup`.** And `setup` now does two things,
  detected by disk state:
  - Fresh repo (no `./xenv/`): bootstrap as before, write the tree,
    generate or honor pinned passphrases, stash keys.
  - Existing repo (someone else's vault cloned, no local keys cached):
    walk each env, prompt for the passphrase (tty no-echo) or honor
    `$XENV_KEY_<ENV>` (CI / non-tty), MAC-verify by decrypting one
    value, cache to `~/.config/xenv/projects/<id>/keys/<env>` on
    success. Skip with a clear message when there's no input.

  This unified flow finally covers the "I just cloned a teammate's
  repo, how do I get going" case without manual `~/.config/` munging.

- **`xenv keygen` → `xenv key generate`.** Moved under the new `key`
  noun-namespace. Full word, no abbreviation.

- **`xenv rotate` → `xenv key rotate`.** Same move. Same behavior.

- **`xenv envs` → `xenv environments`.** Full word.

- **`@<env>` is now required for verbs that take an env.** Old:
  `xenv get production KEY`. New: `xenv get @production KEY`. The
  `@` is the unambiguous "this is an env reference" marker.

- **Argv parser: `@<env>` can appear anywhere in argv.** All three of
  these are equivalent: `xenv get @production API_KEY`, `xenv
  @production get API_KEY`, `xenv get API_KEY @production`. The first
  `@<token>` in argv is extracted and the rest is the verb call.

### Added

- **`xenv key set @<env> [--keychain | --pass | --file] [--force]`.**
  Accept a passphrase from stdin or tty no-echo prompt. MAC-verify
  against existing values; refuse to cache on mismatch unless
  `--force`. Use this to pin a passphrase against an existing vault
  or to re-cache after `key forget`.

- **`xenv key show @<env> [--reveal]`.** Default: print where the
  passphrase lives (file path, keychain service/account, or `pass`
  entry). With `--reveal`: print the actual passphrase to stdout
  (loud foot-gun, explicit flag only).

- **`xenv key forget @<env>`.** Remove the cached passphrase from
  local storage (file/keychain/pass). Leaves the encrypted vault
  intact. For "test the secret-manager path locally" or "deprovision
  this laptop."

### Migration

If you were running 0.7.x: every command needs the verb rename and
the `@` prefix on env args. There's no compatibility layer. The wire
format is unchanged, so your encrypted vaults work as-is — only the
CLI changes.

Recipes (`recipes/{pythong,node,go,rust,gemini}/`) are unaffected.
They speak the wire format, not the verb surface.

## [0.7.2-posix] — 2026-05-21

### Added

- **`xenv @<env>` with no CMD prints the loaded env.** Previously
  errored "needs a command to run." Now decrypts every value in `<env>`
  and writes `KEY=value` lines to stdout — same shape as `env(1)`. Lets
  you peek at the loaded env without exec'ing anything. Multi-line
  values pass through with internal newlines intact; the consumer can
  quote-massage if needed.

  Implementation: factored a `cmd_envdump` helper that shares the
  decrypt loop with `cmd_run` but prints instead of `exec`'ing. The
  `@*)` dispatcher arm now routes to `cmd_envdump` when no CMD follows,
  to `cmd_run` when one does.

  Two new tests; one obsolete test (`@env with no command fails`)
  retired.

## [0.7.1-posix] — 2026-05-21

### Security

- **Constant-time MAC verification in `decrypt_value`.** Previously the
  MAC compare used POSIX shell's `=` operator, which short-circuits on
  the first byte that differs and leaks byte-position information
  through wall-clock timing. The new compare HMACs each side under a
  fresh random per-call key, then compares the resulting digests — the
  byte-by-byte string compare now runs against values uniformly random
  to the attacker, eliminating the side-channel.

  Empirical verification: bad-MAC-first-byte vs bad-MAC-last-byte tested
  at 196.7 ms vs 196.0 ms across 15 trials each. The 0.7 ms gap is well
  within per-call noise (~25 ms variance from PBKDF2). No measurable
  byte-position leak.

  Same trick HMAC-verify implementations use in their internals; see
  Coda Hale's writeup of HMAC verification for the formal argument.

  Cost: two extra SHA-256 HMACs per decrypt. Sub-millisecond. PBKDF2
  (200k iter, ~150 ms) dominates the per-call budget; the new HMACs
  are noise.

  Wire format unchanged. Recipes do not need to update; their
  language-native HMAC `verify_slice` / `compare_digest` / `Equal`
  functions are already constant-time.

### Docs

- README threat model updated: previously admitted the timing
  side-channel; now explains the constant-time mechanism.

## [0.7.0-posix] — prior baseline

Restructure to per-file-per-key + frontmatter format + recipes/. See
`git log` for the full sequence of changes that landed here.
