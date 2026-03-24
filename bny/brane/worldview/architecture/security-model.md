# Security & Encryption Model
AES-256-GCM authenticated encryption with in-memory-only decryption and key injection via environment variables.

## Design

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Encrypt flow:** `xenv encrypt @production` reads `.xenv.production` → generates `.xenv.production.enc`
- **Key injection:** Decryption keys passed via system env: `XENV_KEY_PRODUCTION="hex_string"`
- **Zero-disk policy:** Encrypted vaults are decrypted entirely in memory; secrets are never written to disk

## CLI Commands

```bash
xenv encrypt @production   # encrypt env into vault
xenv decrypt @production   # decrypt vault for editing
xenv keys @production      # generate new key/keyfile
```

## CI/CD Integration

Only `XENV_KEY_[ENV]` needs to be set in the CI/CD or PaaS dashboard. The `.xenv.[env].enc` file is committed to source control.
