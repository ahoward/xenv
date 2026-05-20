---
# xenv project state — DO NOT EDIT — managed by xenv
# id binds this checkout to ~/.config/xenv/projects/<id>/
version: v1
id: xenv-recipes-demo--0000000000000000000000000000demo
---

# xenv/ (demo vault)

A canned xenv tree shipped with the recipes for demonstration. The
encrypted values inside `envs/production/` were generated with the
**DEMO ONLY** passphrase published in `recipes/README.md`.

```
XENV_KEY_PRODUCTION='demo-key-for-recipes-NOT-FOR-REAL-USE'
```

Use this directory to verify that a freshly-built recipe can actually
decrypt and re-encrypt values. See `recipes/try` for the smoke runner.

Contents:

- `HELLO.value.enc`         → `world`
- `DATABASE_URL.value.enc`  → `postgres://localhost/demo`
- `GREETING.value.enc`      → `hi from xenv recipes`
- `APP_ENV.value.enc`       → `production`
