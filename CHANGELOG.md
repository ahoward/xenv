# Changelog

All notable changes to xenv will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project
uses an informal semver-ish scheme tagged in `bin/xenv`'s `XENV_VERSION`.

The full audit trail of every change is in `git log` — this file is for
the changes that affect users.

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
