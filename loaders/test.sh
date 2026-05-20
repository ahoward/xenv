#!/bin/sh
# loaders/test.sh — exercise every checked-in loader against a real vault.
#
# Sets up an xenv project with known values, then invokes each loader's
# CLI and asserts:
#   1. load(env) round-trips every value
#   2. decrypt_one(env, key) matches the corresponding load() entry
#   3. tampering one byte of a .value.enc causes the loader to error
#
# Each loader's CLI must satisfy:
#   <runtime> <loader> <env>             # prints KEY=value lines
#   <runtime> <loader> <env> <key>       # prints just that plaintext
#
# Skips a loader if its runtime is missing (e.g. no `go`, no `node`).

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOADERS="$ROOT/loaders"
XENV="$ROOT/bin/xenv"

PASS=0
FAIL=0
SKIP=0

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

# ── set up a sandbox xenv project ────────────────────────────────

TMP=$(mktemp -d "${TMPDIR:-/tmp}/xenv-loaders.XXXXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM HUP

export XDG_CONFIG_HOME="$TMP/config"
mkdir -p "$XDG_CONFIG_HOME"
cd "$TMP"

"$XENV" init >/dev/null 2>&1 || { red "xenv init failed"; exit 1; }
"$XENV" set production HELLO=world >/dev/null 2>&1
"$XENV" set production DATABASE_URL=postgres://localhost/myapp >/dev/null 2>&1
"$XENV" set production PEM_KEY < /dev/stdin >/dev/null 2>&1 <<'EOF'
-----BEGIN FAKE PEM-----
MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ply1Bzqew=
-----END FAKE PEM-----
EOF

# extract the project id + passphrase for the loader to use
PROJECT_ID=$(awk '/^id:/ {print $2}' xenv/README.md)
XENV_KEY_PRODUCTION=$(cat "$XDG_CONFIG_HOME/xenv/projects/$PROJECT_ID/keys/production")
export XENV_KEY_PRODUCTION
export XENV_ROOT="$TMP/xenv"

# ── assertions ──────────────────────────────────────────────────

assert() {
  msg=$1
  expected=$2
  actual=$3
  if [ "$expected" = "$actual" ]; then
    green "  ok    $msg"
    PASS=$((PASS + 1))
  else
    red   "  FAIL  $msg"
    red   "          expected: $(printf '%s' "$expected" | head -c 200)"
    red   "          actual:   $(printf '%s' "$actual" | head -c 200)"
    FAIL=$((FAIL + 1))
  fi
}

exercise() {
  name=$1
  shift
  printf '%s\n' "$name"

  # ── decrypt_one(production, HELLO)
  out=$("$@" production HELLO 2>&1) || { red "  FAIL  $name decrypt_one failed: $out"; FAIL=$((FAIL+1)); return; }
  assert "$name decrypt_one HELLO" "world" "$out"

  # ── decrypt_one(production, DATABASE_URL)
  out=$("$@" production DATABASE_URL 2>&1) || { red "  FAIL  $name decrypt_one DB failed: $out"; FAIL=$((FAIL+1)); return; }
  assert "$name decrypt_one DATABASE_URL" "postgres://localhost/myapp" "$out"

  # ── load(production) contains every key
  all=$("$@" production 2>&1) || { red "  FAIL  $name load failed: $all"; FAIL=$((FAIL+1)); return; }
  for needle in 'HELLO=world' 'DATABASE_URL=postgres://localhost/myapp' 'PEM_KEY=-----BEGIN FAKE PEM-----'; do
    if printf '%s\n' "$all" | grep -qF "$needle"; then
      green "  ok    $name load contains $needle"
      PASS=$((PASS + 1))
    else
      red   "  FAIL  $name load missing $needle"
      red   "          got: $(printf '%s' "$all" | head -c 300)"
      FAIL=$((FAIL + 1))
    fi
  done

  # ── tamper detection: flip one byte of HELLO's ciphertext, expect failure
  orig=$(cat xenv/envs/production/HELLO.value.enc)
  # change the last hex char of the MAC; predictable but reversible
  tampered=$(printf '%s' "$orig" | awk '{ print substr($0, 1, length($0)-1) (substr($0, length($0)) == "0" ? "1" : "0") }')
  printf '%s\n' "$tampered" > xenv/envs/production/HELLO.value.enc

  if "$@" production HELLO >/dev/null 2>&1; then
    red   "  FAIL  $name accepted tampered envelope (should have errored)"
    FAIL=$((FAIL + 1))
  else
    green "  ok    $name rejects tampered envelope"
    PASS=$((PASS + 1))
  fi
  printf '%s\n' "$orig" > xenv/envs/production/HELLO.value.enc  # restore
}

# ── run each loader if its runtime is available ─────────────────

if command -v python3 >/dev/null 2>&1; then
  exercise "pythong" python3 "$LOADERS/pythong/xenv.py"
else
  yellow "skip: python3 not found"
  SKIP=$((SKIP + 1))
fi

if command -v node >/dev/null 2>&1; then
  exercise "node" node "$LOADERS/node/xenv.js"
else
  yellow "skip: node not found"
  SKIP=$((SKIP + 1))
fi

if command -v go >/dev/null 2>&1; then
  # Go needs to fetch x/crypto first; run from the module dir.
  ( cd "$LOADERS/go" && go mod tidy >/dev/null 2>&1 ) || true
  exercise "go" sh -c 'cd "$0" && go run ./main "$@"' "$LOADERS/go"
else
  yellow "skip: go not found"
  SKIP=$((SKIP + 1))
fi

if command -v cargo >/dev/null 2>&1; then
  # Pre-build the release binary, then invoke it directly. Avoids
  # cargo's progress chatter on every exercise() call.
  ( cd "$LOADERS/rust" && cargo build --release --quiet ) || {
    red "rust: cargo build failed"
    FAIL=$((FAIL + 1))
  }
  exercise "rust" "$LOADERS/rust/target/release/xenv-loader"
else
  yellow "skip: cargo not found"
  SKIP=$((SKIP + 1))
fi

# ── summary ─────────────────────────────────────────────────────

echo
if [ "$FAIL" -eq 0 ]; then
  green "$PASS passed, 0 failed, $SKIP skipped"
  exit 0
else
  red   "$PASS passed, $FAIL failed, $SKIP skipped"
  exit 1
fi
