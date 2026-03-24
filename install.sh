#!/bin/sh
# xenv installer — downloads the latest release binary for your platform.
#
# Usage:
#   curl -fsSL https://ahoward.github.io/xenv/install.sh | sh
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

# download — use sudo if needed
TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE"' EXIT

curl -fsSL -o "$TMPFILE" "$URL"
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
echo "docs: https://github.com/${REPO}"
