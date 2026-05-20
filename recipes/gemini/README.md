# gemini/ — the proof recipe

## the experiment

Hand `recipes/README.md` to a coding agent that wasn't involved in writing it. Have the agent produce a working xenv recipe in some language not already covered. Check it in.

The point isn't "Gemini is good at coding." The point is **regenerative**: if the README is sufficient for *one* agent to build a recipe from scratch, it's sufficient for any agent to do it. The Phoenix architecture promise made concrete.

## the run

Built with **Google's `gemini-2.5-pro`**, called via the raw REST API:

```sh
python3 -c "
import json, sys
spec = open('recipes/README.md').read()
prompt = spec + '\n\n---\n\n# Your task\n\n' + sys.argv[1]
print(json.dumps({'contents': [{'parts': [{'text': prompt}]}]}))
" 'Build a minimal xenv recipe in PHP (single xenv.php file). CLI: php xenv.php
{get|set|load} <env> [<key>] [<value>]. Use PHP stdlib (hash_pbkdf2, hash_hmac,
openssl_encrypt/decrypt, random_bytes, hash_equals). Read $XENV_KEY_<ENV> /
$XENV_KEY for passphrase, $XENV_ROOT for tree (default "./xenv" relative to
cwd). Three operations: get (decrypt one), set (encrypt+write one), load
(decrypt all). Verify MAC before decrypt. Random 16-byte IV, atomic write via
rename. Exit 0 on success, 1 on failure (with "xenv: " prefix on stderr). For
load, print KEY=value lines. Output ONLY PHP code starting with <?php.' \
> /tmp/req.json

curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent" \
  -H 'Content-Type: application/json' \
  -H "X-goog-api-key: $GEMINI_API_KEY" \
  -d @/tmp/req.json | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['candidates'][0]['content']['parts'][0]['text'])" \
  > recipes/gemini/xenv.php
```

Total time: a few seconds of inference. Total cost: pennies. Total prompt: the
contents of `recipes/README.md` (~12 KB) plus one paragraph of task framing.

(Note on the API key form: use `-H "X-goog-api-key: $GEMINI_API_KEY"`, not
`?key=...` on the URL. The query-param form routes through Google's free-tier
quotas regardless of your paid-tier status; the header form correctly bills
your project at its tier.)

## the result

[`xenv.php`](xenv.php) — 315 lines of PHP. Zero edits. Drop the file in, run it, it works:

```sh
XENV_KEY_PRODUCTION='demo-key-for-recipes-NOT-FOR-REAL-USE' \
  XENV_ROOT="$(pwd)/recipes/xenv" \
  php recipes/gemini/xenv.php get production HELLO
# → world

XENV_KEY_PRODUCTION='demo-key-for-recipes-NOT-FOR-REAL-USE' \
  XENV_ROOT="$(pwd)/recipes/xenv" \
  php recipes/gemini/xenv.php load production
# → APP_ENV=production
# → DATABASE_URL=postgres://localhost/demo
# → GREETING=hi from xenv recipes
# → HELLO=world
```

`set` writes envelopes that the canonical `xenv` shell tool can decrypt — the
cross-tool round-trip in `recipes/test` verifies this for every recipe,
including this one.

Interestingly, Pro chose flat procedural style (`xenv_get`, `xenv_set`,
`xenv_load` + helpers), while an earlier Flash-built version had chosen OOP (one
`Xenv` class). Both passed every assertion. Both are valid implementations of
the spec. The README doesn't dictate style; it dictates behavior.

## what this proves

A coding agent given **only** `recipes/README.md` (no access to `bin/xenv`, no
reference to the other recipes) produces a working implementation that:

1. Parses the YAML frontmatter correctly
2. Derives keys via PBKDF2-SHA256 → 64 bytes → split halves
3. Verifies MAC before decrypting (encrypt-then-MAC discipline)
4. Generates fresh IVs via `random_bytes`
5. Writes envelopes that round-trip with every other recipe AND the shell tool

The prompt is the spec. The recipes are reconstructable outputs. Burn it all
down; it rises from the ashes.

## reproducing

Quota reset, different model, fresh repo — should still work. If it doesn't,
the prompt has drifted from the format. Fix the prompt; the recipes follow.
