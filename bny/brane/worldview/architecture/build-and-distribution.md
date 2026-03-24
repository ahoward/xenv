# Build & Distribution
Compiled from Bun/TypeScript into cross-platform static binaries.

## Compilation

```bash
bun build ./src/cli.ts --compile --minify --target=bun-linux-x64 --outfile=xenv
```

## Target Platforms

- Linux: x64, arm64
- macOS: x64, arm64
- Windows

## Distribution Channels (Planned)

- Homebrew
- npm install script
- curl | bash script
