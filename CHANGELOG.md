# Changelog

All notable changes to xenv will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project
uses an informal semver-ish scheme tagged in `bin/xenv`'s `XENV_VERSION`.

The full audit trail of every change is in `git log` — this file is for
the changes that affect users.

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
