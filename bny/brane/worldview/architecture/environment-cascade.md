# Environment Resolution Cascade
Variables are merged in a strict, deterministic order where later sources overwrite earlier ones.

## Resolution Order

| Order | File | Description | Source Control |
|---|---|---|---|
| 1 | `.env` | Legacy base defaults | Committed |
| 2 | `.xenv` | Modern base defaults | Committed |
| 3 | `.env.local` / `.xenv.local` | Developer-specific local overrides | `.gitignore` |
| 4 | `.env.[env]` / `.xenv.[env]` | Environment-specific plaintext | Committed |
| 5 | `.xenv.[env].enc` | Encrypted vault (decrypted in-memory) | Committed |
| 6 | `.env.[env].local` / `.xenv.[env].local` | Local testing overrides for specific env | `.gitignore` |
| 7 | System `ENV` | Process environment variables | System-level |

## Conflict Rules

- Later layers overwrite earlier ones
- If both `.env` and `.xenv` exist at the same priority level, `.xenv` wins
- System ENV always has final authority
