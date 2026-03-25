#!/bin/sh
# xenv installer — downloads the latest release binary for your platform.
#
# Usage:
#   curl -fsSL https://xenv.sh/install.sh | sh
#
# Environment:
#   XENV_INSTALL_DIR  — where to install (default: /usr/local/bin)
#   XENV_VERSION      — specific version tag (default: latest)

set -e

REPO="ahoward/xenv"
INSTALL_DIR="${XENV_INSTALL_DIR:-/usr/local/bin}"

# detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *)      echo "error: unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_NAME="x86_64" ;;
  arm64|aarch64)  ARCH_NAME="aarch64" ;;
  *)              echo "error: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

BINARY="xenv-${PLATFORM}-${ARCH_NAME}"

# resolve version
if [ -n "$XENV_VERSION" ]; then
  TAG="$XENV_VERSION"
else
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | cut -d '"' -f 4)"
  if [ -z "$TAG" ]; then
    echo "error: could not determine latest release — set XENV_VERSION manually" >&2
    exit 1
  fi
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY}"

echo "installing xenv ${TAG} (${PLATFORM}/${ARCH_NAME})"
echo "  from: ${URL}"
echo "  to:   ${INSTALL_DIR}/xenv"

# download binary and checksums
TMPFILE="$(mktemp)"
TMPCHECK="$(mktemp)"
trap 'rm -f "$TMPFILE" "$TMPCHECK"' EXIT

curl -fsSL -o "$TMPFILE" "$URL"

CHECKSUM_URL="https://github.com/${REPO}/releases/download/${TAG}/checksums.txt"
if curl -fsSL -o "$TMPCHECK" "$CHECKSUM_URL" 2>/dev/null; then
  EXPECTED="$(grep "  ${BINARY}$" "$TMPCHECK" | cut -d ' ' -f 1)"
  if [ -n "$EXPECTED" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL="$(sha256sum "$TMPFILE" | cut -d ' ' -f 1)"
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL="$(shasum -a 256 "$TMPFILE" | cut -d ' ' -f 1)"
    else
      echo "  warning: no sha256sum or shasum found — skipping checksum verification" >&2
      ACTUAL="$EXPECTED"
    fi
    if [ "$ACTUAL" != "$EXPECTED" ]; then
      echo "error: checksum mismatch!" >&2
      echo "  expected: ${EXPECTED}" >&2
      echo "  actual:   ${ACTUAL}" >&2
      echo "  the downloaded binary may be corrupted or tampered with." >&2
      exit 1
    fi
    echo "  checksum: verified ✓"
  else
    echo "  warning: binary not found in checksums.txt — skipping verification" >&2
  fi
else
  echo "  warning: checksums.txt not available — skipping verification" >&2
fi

chmod +x "$TMPFILE"

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "${INSTALL_DIR}/xenv"
else
  echo ""
  echo "  ${INSTALL_DIR} is not writable — using sudo"
  sudo mv "$TMPFILE" "${INSTALL_DIR}/xenv"
fi

echo ""
echo "xenv installed successfully!"
echo ""
echo "  xenv --version     verify installation"
echo "  xenv init          bootstrap xenv in your project"
echo "  xenv --help        see all commands"
echo ""
echo "docs: https://xenv.sh"
