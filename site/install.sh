#!/bin/sh
# xenv installer — pinned, checksummed, non-interactive.
#
#   curl -fsSL https://xenv.sh/install | sh
#   curl -fsSL https://xenv.sh/install | XENV_INSTALL_DIR=/usr/local/bin sh
#   curl -fsSL https://xenv.sh/install | XENV_INSTALL_VERSION=v0.19.0 sh
#
# Fetches a PINNED version of the xenv script from a tag and verifies its
# sha256 BEFORE installing. No prompts. No remote code is executed except
# this installer itself; the fetched xenv is checksum-verified, then placed
# on disk — never piped to a shell. Exits non-zero on any mismatch.
#
# The trust root is this file: it pins (version -> sha256). Updated on each
# release. To install a version not listed here, add its checksum or set
# both XENV_INSTALL_VERSION and XENV_INSTALL_SHA256.
set -eu

VERSION="${XENV_INSTALL_VERSION:-v0.19.0}"
INSTALL_DIR="${XENV_INSTALL_DIR:-$HOME/.local/bin}"
REPO="ahoward/xenv"

# pinned sha256 of bin/xenv at each release tag (append on release)
sha_for() {
  case "$1" in
    v0.19.0) echo "67b3c89b1d41db5144b6c6d14d3444d7e9de5ed81842ef7c915fee74e13c16b7" ;;
    *)       echo "" ;;
  esac
}

want="${XENV_INSTALL_SHA256:-$(sha_for "$VERSION")}"
if [ -z "$want" ]; then
  echo "xenv-install: no pinned checksum for $VERSION." >&2
  echo "  pick a listed release, or set XENV_INSTALL_SHA256 to its known sha256." >&2
  exit 1
fi

url="https://raw.githubusercontent.com/$REPO/$VERSION/bin/xenv"
tmp=$(mktemp "${TMPDIR:-/tmp}/xenv-install.XXXXXXXX") || { echo "xenv-install: mktemp failed" >&2; exit 1; }
trap 'rm -f "$tmp"' EXIT INT TERM HUP

# fetch (curl or wget)
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp" || { echo "xenv-install: download failed: $url" >&2; exit 1; }
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url" || { echo "xenv-install: download failed: $url" >&2; exit 1; }
else
  echo "xenv-install: need curl or wget" >&2; exit 1
fi

# verify sha256 (sha256sum | shasum -a 256 | openssl)
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  got=$(shasum -a 256 "$tmp" | awk '{print $1}')
elif command -v openssl >/dev/null 2>&1; then
  got=$(openssl dgst -sha256 "$tmp" | awk '{print $NF}')
else
  echo "xenv-install: no sha256 tool found (sha256sum / shasum / openssl)" >&2; exit 1
fi

if [ "$got" != "$want" ]; then
  echo "xenv-install: CHECKSUM MISMATCH for $VERSION — refusing to install." >&2
  echo "  expected $want" >&2
  echo "  got      $got" >&2
  exit 1
fi

# install atomically
mkdir -p "$INSTALL_DIR" || { echo "xenv-install: cannot create $INSTALL_DIR" >&2; exit 1; }
chmod +x "$tmp"
mv "$tmp" "$INSTALL_DIR/xenv" || { echo "xenv-install: cannot write $INSTALL_DIR/xenv" >&2; exit 1; }
trap - EXIT INT TERM HUP

echo "xenv-install: installed $VERSION -> $INSTALL_DIR/xenv (sha256 verified)"
case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*) : ;;
  *) echo "xenv-install: note — $INSTALL_DIR is not on \$PATH; add it to use 'xenv'." >&2 ;;
esac
echo "xenv-install: run 'xenv version' to check, 'xenv setup' to start."
