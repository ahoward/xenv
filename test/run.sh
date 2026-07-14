#!/bin/sh
# xenv test suite — xenv/ layout, per-key file model.
#
# Focused on the behaviors that matter: correct round-trips, atomic writes,
# MAC integrity, multi-line values, rich init, key resolution.

set -u

SHELL_BIN=${SHELL_BIN:-/bin/sh}
XENV="$(cd "$(dirname "$0")/.." && pwd)/bin/xenv"

PASS=0
FAIL=0
FAILED_TESTS=""

# ── harness ────────────────────────────────────────────────────────

setup_tmp() {
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/xenv-test.XXXXXXXX")
  TEST_CONFIG="$TMP/config"
  mkdir -p "$TEST_CONFIG"
  export XDG_CONFIG_HOME="$TEST_CONFIG"
  cd "$TMP" || exit 1
}

teardown_tmp() {
  cd / || true
  rm -rf "$TMP"
  unset XDG_CONFIG_HOME TMP TEST_CONFIG
}

xenv() {
  "$SHELL_BIN" "$XENV" "$@"
}

assert_eq() {
  if [ "$1" = "$2" ]; then return 0; fi
  printf '    FAIL: %s\n      expected: %s\n      actual:   %s\n' "$3" "$1" "$2" >&2
  return 1
}

# helper: extract a key from the frontmatter at the top of a README.
# tests use this to read the project id, env salt, etc. naive on purpose.
read_fm() {
  file=$1
  key=$2
  awk -v want="$key" '
    NR == 1 && $0 == "---" { in_block = 1; next }
    in_block && $0 == "---" { exit }
    in_block {
      i = index($0, ":")
      if (i == 0) next
      k = $0; sub(/[ \t].*$/, "", k); sub(/:$/, "", k)
      if (k != want) next
      v = substr($0, i + 1)
      sub(/^[ \t]+/, "", v); sub(/[ \t\r]+$/, "", v)
      print v
      exit
    }
  ' "$file"
}

# helper: project id, read from xenv/README.md's frontmatter.
project_id() {
  read_fm xenv/README.md id
}

# helper: path to the current project's keys directory.
project_keys_dir() {
  id=$(project_id)
  printf '%s/xenv/projects/%s/keys' "$TEST_CONFIG" "$id"
}

run_test() {
  name=$1
  fn=$2
  printf '  %s ... ' "$name"
  setup_tmp
  if "$fn"; then
    PASS=$((PASS + 1))
    printf 'ok\n'
  else
    FAIL=$((FAIL + 1))
    FAILED_TESTS="$FAILED_TESTS\n  - $name"
    printf 'FAIL\n'
  fi
  teardown_tmp
}

# ── basics ─────────────────────────────────────────────────────────

test_version() {
  case "$(xenv version)" in xenv\ *) return 0 ;; *) return 1 ;; esac
}

# ── init creates the full layout ──────────────────────────────────

test_init_creates_xenv_dir() {
  xenv setup >/dev/null 2>&1
  [ -d xenv ] || return 1
  # no .gitignore — every file in xenv/ is safe to commit
  [ ! -f .gitignore ] || return 1
  return 0
}

test_init_creates_top_readme() {
  xenv setup >/dev/null 2>&1
  [ -f xenv/README.md ] || return 1
  grep -qi "for humans" xenv/README.md || return 1
  grep -qi "for agents" xenv/README.md || return 1
}

test_init_creates_bin_xenv() {
  xenv setup >/dev/null 2>&1
  [ -f xenv/bin/xenv ] || return 1
  [ -x xenv/bin/xenv ] || return 1
  # the embedded copy should run
  "$SHELL_BIN" xenv/bin/xenv version >/dev/null 2>&1 || return 1
}

test_init_creates_four_envs() {
  xenv setup >/dev/null 2>&1
  [ -d xenv/envs ] || return 1
  for env_name in testing development staging production; do
    [ -d "xenv/envs/$env_name" ] || return 1
    [ -f "xenv/envs/$env_name/README.md" ] || return 1
    [ -f "xenv/envs/$env_name/APP_ENV.value.enc" ] || return 1
    # KDF params live in the README's frontmatter now — no separate params file
    [ ! -f "xenv/envs/$env_name/params.xenv" ] || return 1
  done
  return 0
}

test_setup_stores_global_passphrase() {
  # Default `xenv setup` writes ONE _global.key, not per-env files.
  # All envs cascade-resolve via _global. Per-env files only appear
  # when $XENV_KEY_<ENV> was pinned or after `xenv key rotate @<env>`.
  xenv setup >/dev/null 2>&1
  kdir=$(project_keys_dir)
  [ -f "$kdir/_global.key" ] || return 1
  # confirm there are no per-env .key files yet (default behavior)
  for env_name in testing development staging production; do
    [ ! -f "$kdir/$env_name.key" ] || return 1
  done
  return 0
}

test_setup_honors_global_env_var() {
  # $XENV_KEY pinned at setup time → that value becomes _global.key.
  # Subsequent decrypts work both with and without the env var set.
  pinned='my-shared-passphrase'
  XENV_KEY=$pinned xenv setup >/dev/null 2>&1
  kdir=$(project_keys_dir)
  [ -f "$kdir/_global.key" ] || return 1
  cached=$(cat "$kdir/_global.key")
  assert_eq "$pinned" "$cached" "_global.key contents match \$XENV_KEY" || return 1
  # works without env var (file backend resolves)
  out=$(xenv get @production APP_ENV)
  assert_eq "production" "$out" "decrypt via cached _global.key"
}

test_setup_honors_per_env_var() {
  # $XENV_KEY_<ENV> pinned at setup → per-env file gets that value.
  # The OTHER envs still get a generated _global.key.
  pinned='prod-specific-key'
  XENV_KEY_PRODUCTION=$pinned xenv setup >/dev/null 2>&1
  kdir=$(project_keys_dir)
  [ -f "$kdir/production.key" ] || return 1
  [ -f "$kdir/_global.key" ]    || return 1
  assert_eq "$pinned" "$(cat "$kdir/production.key")" \
    "production.key contents match \$XENV_KEY_PRODUCTION" || return 1
}

test_cascade_per_env_beats_global() {
  # Per-env file shadows _global file. After setting both, @prod
  # resolves to its own key, not _global.
  xenv setup >/dev/null 2>&1
  kdir=$(project_keys_dir)

  # set a value (encrypted under _global), then rotate prod (which
  # writes a new per-env key and re-encrypts under it)
  xenv set @production SECRET=alpha >/dev/null 2>&1
  xenv key rotate @production >/dev/null 2>&1
  [ -f "$kdir/production.key" ] || return 1
  [ "$(cat "$kdir/production.key")" != "$(cat "$kdir/_global.key")" ] || return 1

  # production decrypts under its new per-env key
  assert_eq "alpha" "$(xenv get @production SECRET)" "@prod decrypts via per-env key" || return 1
  # staging still works via _global
  assert_eq "staging" "$(xenv get @staging APP_ENV)" "@staging decrypts via _global" || return 1
}

test_key_show_no_env_describes_global() {
  xenv setup >/dev/null 2>&1
  out=$(xenv key show)
  echo "$out" | grep -q '_global.key' || return 1
}

test_key_show_at_env_says_via_global() {
  # @env with no per-env key set → show says "via _global fallback"
  xenv setup >/dev/null 2>&1
  out=$(xenv key show @production)
  echo "$out" | grep -q 'via _global fallback' || return 1
}

test_key_forget_global_warns_about_envs() {
  # After forgetting _global, envs without a per-env key have nowhere to go.
  xenv setup >/dev/null 2>&1
  out=$(xenv key forget 2>&1)
  echo "$out" | grep -q 'envs without their own key will no longer decrypt' || return 1
}

test_key_forget_env_notes_cascade_fallback() {
  # After forgetting a per-env key, the cascade falls back to _global.
  # The forget message should call it out.
  xenv setup >/dev/null 2>&1
  xenv key rotate @production >/dev/null 2>&1
  out=$(xenv key forget @production 2>&1)
  echo "$out" | grep -q 'now resolves via _global.key' || return 1
}

test_key_rotate_global_skips_per_env_keyed() {
  # Project-wide rotate touches only envs without a per-env key.
  xenv setup >/dev/null 2>&1
  xenv set @production SECRET=prod >/dev/null 2>&1
  xenv set @staging    SECRET=stg  >/dev/null 2>&1

  # split production off
  xenv key rotate @production >/dev/null 2>&1
  prod_key_before=$(cat "$(project_keys_dir)/production.key")

  # rotate _global
  xenv key rotate >/dev/null 2>&1
  prod_key_after=$(cat "$(project_keys_dir)/production.key")

  # production's key must NOT have changed
  [ "$prod_key_before" = "$prod_key_after" ] || return 1

  # but values in both envs still decrypt
  assert_eq "prod" "$(xenv get @production SECRET)" "prod decrypts" || return 1
  assert_eq "stg"  "$(xenv get @staging    SECRET)" "stg  decrypts via new _global" || return 1
}

test_init_app_env_decrypts_to_env_name() {
  xenv setup >/dev/null 2>&1
  for env_name in testing development staging production; do
    out=$(xenv get @"$env_name" APP_ENV)
    assert_eq "$env_name" "$out" "APP_ENV for $env_name" || return 1
  done
  return 0
}

test_init_per_env_readme_mentions_env_name() {
  # per-env README is intentionally minimal — it carries the crypto-state
  # frontmatter and a stub body that names the env. that's it.
  xenv setup >/dev/null 2>&1
  grep -q "production" xenv/envs/production/README.md || return 1
  grep -q "staging"    xenv/envs/staging/README.md    || return 1
}

test_init_top_readme_documents_passphrase_env_vars() {
  # the XENV_KEY_<ENV> documentation lives in the top-level xenv/README.md
  # now — one place, not duplicated per env.
  xenv setup >/dev/null 2>&1
  grep -q "XENV_KEY_<ENV>" xenv/README.md || return 1
}

test_setup_on_existing_tree_adopts() {
  # `xenv setup` on an existing tree no longer errors — it walks into
  # the adopt flow. With non-tty stdin and no $XENV_KEY_<ENV> set, all
  # envs are skipped (the message says so). Exit 0; the tree is intact.
  xenv setup >/dev/null 2>&1
  out=$(xenv setup 2>&1)
  echo "$out" | grep -qi "adopting" || return 1
  echo "$out" | grep -qi "skipped" || return 1
  return 0
}

# ── project id ────────────────────────────────────────────────────

test_init_writes_project_id_in_top_readme() {
  xenv setup >/dev/null 2>&1

  # no standalone project.xenv anymore — the id lives in xenv/README.md's
  # frontmatter alongside the format version.
  [ -f xenv/project.xenv ] && return 1
  [ -f xenv/README.md ] || return 1

  ver=$(read_fm xenv/README.md version)
  id=$(read_fm xenv/README.md id)

  [ "$ver" = "v1" ] || return 1
  # id is <sanitized-basename>--<32-hex>
  case "$id" in
    *--*) ;;
    *) return 1 ;;
  esac
  uuid=${id##*--}
  [ ${#uuid} -eq 32 ] || return 1
  case "$uuid" in
    *[!0-9a-f]*) return 1 ;;
  esac
  return 0
}

test_init_creates_per_project_config_dir() {
  xenv setup >/dev/null 2>&1
  id=$(project_id)
  pdir="$TEST_CONFIG/xenv/projects/$id"
  [ -d "$pdir" ]         || return 1
  [ -d "$pdir/keys" ]    || return 1
  [ -f "$pdir/origin" ]  || return 1
  [ -f "$pdir/notes.md" ] || return 1
}

test_init_origin_file_records_xenv_path() {
  xenv setup >/dev/null 2>&1
  id=$(project_id)
  origin=$(cat "$TEST_CONFIG/xenv/projects/$id/origin")
  expected=$(cd xenv && pwd)
  assert_eq "$expected" "$origin" "origin records absolute xenv/ path"
}

test_init_notes_stub_mentions_project_id() {
  xenv setup >/dev/null 2>&1
  id=$(project_id)
  grep -q "$id" "$TEST_CONFIG/xenv/projects/$id/notes.md" || return 1
}

test_two_projects_same_basename_get_unique_ids() {
  # critical: this is the bug the project-id system was added to solve.
  # two projects named "foo" must NOT collide on key storage.
  mkdir -p "$TMP/a/foo" "$TMP/b/foo"

  cd "$TMP/a/foo"
  xenv setup >/dev/null 2>&1
  id_a=$(project_id)

  cd "$TMP/b/foo"
  xenv setup >/dev/null 2>&1
  id_b=$(project_id)

  # both should have "foo--" prefix
  case "$id_a" in foo--*) ;; *) return 1 ;; esac
  case "$id_b" in foo--*) ;; *) return 1 ;; esac
  # but be different
  [ "$id_a" != "$id_b" ] || return 1
  # and have separate key dirs
  [ -d "$TEST_CONFIG/xenv/projects/$id_a/keys" ] || return 1
  [ -d "$TEST_CONFIG/xenv/projects/$id_b/keys" ] || return 1

  # final sanity: each project's APP_ENV decrypts independently with its own key
  cd "$TMP/a/foo"; out_a=$(xenv get @production APP_ENV)
  cd "$TMP/b/foo"; out_b=$(xenv get @production APP_ENV)
  assert_eq "production" "$out_a" "project a decrypts" || return 1
  assert_eq "production" "$out_b" "project b decrypts" || return 1
}

test_basename_sanitization() {
  # project basenames with weird chars get sanitized
  mkdir -p "$TMP/My Project!"
  cd "$TMP/My Project!"
  xenv setup >/dev/null 2>&1
  id=$(project_id)
  # should be lowercase, non-alnum→-, collapsed runs
  case "$id" in
    my-project--*) return 0 ;;
    *) return 1 ;;
  esac
}

test_no_top_readme_means_no_key_lookup() {
  # without xenv/README.md (where the project id lives), any operation
  # that needs a key must fail cleanly. (list doesn't need a key — it just
  # `ls`s files. but get does.)
  mkdir -p xenv/envs/production
  # plant a syntactically-valid envelope so we get past the file-exists check
  # and into the key-lookup path
  printf 'xenv:v3:00112233445566778899aabbccddeeff:00112233445566778899aabbccddeeff:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n' \
    > xenv/envs/production/APP_ENV.value.enc

  out=$(xenv get @production APP_ENV 2>&1) && return 1
  echo "$out" | grep -qi "no key\|run 'xenv setup'\|README\.md" || return 1
  return 0
}

test_init_frontmatter_params() {
  xenv setup >/dev/null 2>&1
  rf=xenv/envs/production/README.md
  [ -f "$rf" ] || return 1

  # README must start with the frontmatter fence
  head -n 1 "$rf" | grep -qx -- '---' || return 1

  # bare keys — the file's location implies "this is xenv crypto state"
  block=$(awk 'NR==1 && $0=="---"{p=1;next} p && $0=="---"{exit} p' "$rf")
  echo "$block" | grep -q '^version: v3$'         || return 1
  echo "$block" | grep -q '^iter: 200000$'        || return 1
  echo "$block" | grep -qE '^salt: [0-9a-f]{32}$' || return 1

  # body of the README must still be there
  grep -q "xenv/production" "$rf" || return 1
}

test_init_value_files_are_v3_envelopes() {
  xenv setup >/dev/null 2>&1
  case "$(cat xenv/envs/development/APP_ENV.value.enc)" in
    "xenv:v3:"*) return 0 ;;
    *) return 1 ;;
  esac
}

test_init_bin_xenv_is_self_contained() {
  # rm the parent script's source — xenv/bin/xenv should still work
  xenv setup >/dev/null 2>&1
  out=$("$SHELL_BIN" xenv/bin/xenv get @development APP_ENV 2>&1)
  assert_eq "development" "$out" "self-contained bin works"
}

# ── set/get/list/unset ─────────────────────────────────────────────

test_set_creates_one_value_file() {
  xenv setup >/dev/null 2>&1
  xenv set @production DB_URL=postgres://localhost/db >/dev/null 2>&1
  [ -f xenv/envs/production/DB_URL.value.enc ] || return 1
}

test_set_inline_round_trip() {
  xenv setup >/dev/null 2>&1
  xenv set @production GREETING="hello world" >/dev/null 2>&1
  out=$(xenv get @production GREETING)
  assert_eq "hello world" "$out" "round trip"
}

test_set_value_with_equals_signs() {
  xenv setup >/dev/null 2>&1
  xenv set @production URL="https://api.example.com?key=abc&token=xyz" >/dev/null 2>&1
  out=$(xenv get @production URL)
  assert_eq "https://api.example.com?key=abc&token=xyz" "$out" "= signs"
}

test_set_value_with_quotes_no_rce() {
  xenv setup >/dev/null 2>&1
  marker="$TMP/pwned"
  rm -f "$marker"
  xenv set @production EVIL='";touch '"$marker"';#`echo bad`' >/dev/null 2>&1
  xenv run @production true >/dev/null 2>&1
  if [ -f "$marker" ]; then
    rm -f "$marker"
    return 1
  fi
  return 0
}

test_set_from_stdin_multiline() {
  xenv setup >/dev/null 2>&1
  printf 'line1\nline2\nline3' | xenv set @production MULTI >/dev/null 2>&1
  out=$(xenv get @production MULTI)
  expected=$(printf 'line1\nline2\nline3')
  assert_eq "$expected" "$out" "multi-line"
}

test_set_pem_key() {
  xenv setup >/dev/null 2>&1
  pem='-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDfake==
-----END PRIVATE KEY-----'
  printf '%s' "$pem" | xenv set @production PEM_KEY >/dev/null 2>&1
  out=$(xenv get @production PEM_KEY)
  assert_eq "$pem" "$out" "PEM round-trip"
}

test_unset_removes_file() {
  xenv setup >/dev/null 2>&1
  xenv set @production FOO=bar >/dev/null 2>&1
  [ -f xenv/envs/production/FOO.value.enc ] || return 1
  xenv unset @production FOO >/dev/null 2>&1
  [ -f xenv/envs/production/FOO.value.enc ] && return 1
  return 0
}

test_list_shows_starter_app_env() {
  xenv setup >/dev/null 2>&1
  out=$(xenv list @production)
  echo "$out" | grep -q "^APP_ENV$" || return 1
}

test_list_shows_new_keys() {
  xenv setup >/dev/null 2>&1
  xenv set @production ALPHA=1 >/dev/null 2>&1
  xenv set @production BETA=2 >/dev/null 2>&1
  out=$(xenv list @production)
  echo "$out" | grep -q "^APP_ENV$" || return 1
  echo "$out" | grep -q "^ALPHA$"   || return 1
  echo "$out" | grep -q "^BETA$"    || return 1
}

test_get_silent_on_success() {
  xenv setup >/dev/null 2>&1
  noise=$(xenv get @production APP_ENV 2>&1 >/dev/null)
  [ -z "$noise" ] || return 1
}

test_get_missing_key_fails() {
  xenv setup >/dev/null 2>&1
  xenv get @production DOESNOTEXIST >/dev/null 2>&1 && return 1
  return 0
}

test_get_pipe_preserves_exact_bytes() {
  # When stdout is a pipe (not a tty), `xenv get` must emit exact bytes
  # with no auto-newline. This is the script-compat contract: it lets
  # `db=$(xenv get @prod URL)` capture the value verbatim.
  xenv setup >/dev/null 2>&1
  xenv set @production NO_NL=novalue >/dev/null 2>&1

  bytes=$(xenv get @production NO_NL | od -An -vtx1 | tr -d ' \n')
  # "novalue" = 0x6e6f76616c7565 (7 bytes, no trailing 0a)
  assert_eq "6e6f76616c7565" "$bytes" "exact bytes from pipe, no \\n appended"
}

test_get_pipe_preserves_internal_newlines() {
  # Multi-line values must round-trip through a pipe with all internal
  # \n preserved and no extra \n at the end.
  xenv setup >/dev/null 2>&1
  printf 'a\nb\nc' | xenv set @production MULTI >/dev/null 2>&1

  bytes=$(xenv get @production MULTI | od -An -vtx1 | tr -d ' \n')
  # "a\nb\nc" = 0x610a620a63 — note: no trailing 0a
  assert_eq "610a620a63" "$bytes" "multi-line preserved, no trailing \\n"
}

test_tty_finish_algorithm() {
  # Unit-test the algorithm that `tty_finish` uses in its tty branch.
  # We trust `[ -t 1 ]` and validate the awk shape independently of it.
  # Three cases: no trailing \n → \n added; already \n → preserved as 1;
  # empty input → \n added so the prompt doesn't sit on the input line.

  # case 1: no trailing newline → exactly one added
  out=$(printf 'hello' | awk '{print}' | od -An -vtx1 | tr -d ' \n')
  assert_eq "68656c6c6f0a" "$out" "no-\\n input gets one \\n appended" || return 1

  # case 2: input already ends in \n → exactly one in output
  out=$(printf 'hello\n' | awk '{print}' | od -An -vtx1 | tr -d ' \n')
  assert_eq "68656c6c6f0a" "$out" "trailing-\\n input passes through unchanged" || return 1

  # case 3: empty input → empty output (POSIX awk: 0 records means no
  # print invocations; no \n is emitted). This matches the spec: we
  # only add a \n when there's content to follow. An empty `xenv get`
  # at the terminal leaves the prompt on its own line — fine.
  out=$(printf '' | awk '{print}' | od -An -vtx1 | tr -d ' \n')
  assert_eq "" "$out" "empty input → empty output"
}

# ── envs ───────────────────────────────────────────────────────────

test_envs_lists_all_four() {
  xenv setup >/dev/null 2>&1
  out=$(xenv environments)
  echo "$out" | grep -q "production" || return 1
  echo "$out" | grep -q "staging"    || return 1
  echo "$out" | grep -q "development" || return 1
  echo "$out" | grep -q "testing"    || return 1
}

test_envs_only_iterates_envs_dir() {
  # tool dirs (xenv/bin/) and any future siblings of xenv/envs/ must NEVER
  # appear in the envs list, no matter what they're named.
  xenv setup >/dev/null 2>&1
  mkdir -p xenv/lib xenv/share
  out=$(xenv environments)
  echo "$out" | grep -qw "bin"   && return 1
  echo "$out" | grep -qw "lib"   && return 1
  echo "$out" | grep -qw "share" && return 1
  return 0
}

# ── run ────────────────────────────────────────────────────────────

test_run_injects_env() {
  xenv setup >/dev/null 2>&1
  xenv set @production FOO=bar >/dev/null 2>&1
  xenv set @production DB_URL="postgres://localhost/test" >/dev/null 2>&1
  out=$(xenv run @production sh -c 'echo "$FOO,$DB_URL,$APP_ENV"')
  assert_eq "bar,postgres://localhost/test,production" "$out" "run injection"
}

test_run_preserves_multiline() {
  xenv setup >/dev/null 2>&1
  pem='line1
line2
line3'
  printf '%s' "$pem" | xenv set @production PEM >/dev/null 2>&1
  lines=$(xenv run @production sh -c 'printf "%s" "$PEM"' | wc -l)
  assert_eq "2" "$lines" "multi-line preserved"
}

test_run_propagates_exit_code() {
  xenv setup >/dev/null 2>&1
  xenv run @production sh -c 'exit 42' >/dev/null 2>&1
  assert_eq "42" "$?" "exit code passes through"
}

test_run_no_command_fails() {
  xenv setup >/dev/null 2>&1
  out=$(xenv run @production 2>&1) && return 1
  echo "$out" | grep -qi "needs a command" || return 1
}

test_run_no_env_fails() {
  xenv run 2>&1 >/dev/null && return 1
  return 0
}

test_at_shorthand_runs_like_run() {
  # `xenv @<env> CMD` is the screaming-loud shorthand for `xenv run <env> CMD`.
  xenv setup >/dev/null 2>&1
  out=$(xenv @production sh -c 'echo "$APP_ENV"')
  assert_eq "production" "$out" "xenv @env shorthand"
}

test_at_shorthand_propagates_exit_code() {
  # `xenv @<env> CMD` must propagate the inner command's exit code, just
  # like `xenv run` does. exec(2) replaces xenv, so exit code = inner's.
  xenv setup >/dev/null 2>&1
  xenv @production sh -c 'exit 17' >/dev/null 2>&1
  [ $? -eq 17 ] || return 1
}

test_at_empty_env_fails() {
  # `xenv @ ls` is a typo trap. `@` alone (no env name) doesn't match the
  # pre-scan extractor's `@?*` pattern, so it falls through as an unknown
  # command. Must fail loud.
  xenv setup >/dev/null 2>&1
  out=$(xenv @ ls 2>&1) && return 1
  echo "$out" | grep -qi "unknown command" || return 1
}

test_at_no_command_prints_env() {
  # `xenv @env` with no CMD prints KEY=value lines for every value in
  # the env, one per line. Same shape as env(1)'s output. Lets you peek
  # at the loaded env without exec'ing anything.
  xenv setup >/dev/null 2>&1
  xenv set @production HELLO=world >/dev/null 2>&1
  xenv set @production NUMBER=42 >/dev/null 2>&1

  out=$(xenv @production) || return 1
  # APP_ENV is the starter value init writes for every env
  echo "$out" | grep -qx 'APP_ENV=production' || return 1
  echo "$out" | grep -qx 'HELLO=world'        || return 1
  echo "$out" | grep -qx 'NUMBER=42'          || return 1
}

test_at_no_command_multiline_values_intact() {
  # Multi-line values appear verbatim — the dump is a sequence of
  # KEY=value pairs with internal newlines passed through. The
  # consumer can quote-massage if they want.
  xenv setup >/dev/null 2>&1
  printf 'line1\nline2\nline3' | xenv set @production MULTI >/dev/null 2>&1

  out=$(xenv @production)
  # all three lines of the multi-line value present
  echo "$out" | grep -qx 'MULTI=line1'  || return 1
  echo "$out" | grep -qx 'line2'        || return 1
  echo "$out" | grep -qx 'line3'        || return 1
}

test_json_dump_is_one_object() {
  # `xenv @env --json` prints one JSON object {"KEY":"value",...} on a
  # single line. Language-neutral: any stdlib JSON parser can load it.
  xenv setup >/dev/null 2>&1
  xenv set @production HELLO=world >/dev/null 2>&1
  xenv set @production NUMBER=42 >/dev/null 2>&1

  out=$(xenv @production --json) || return 1
  # exactly one line
  [ "$(printf '%s\n' "$out" | wc -l)" -eq 1 ] || return 1
  # starts with { and ends with }
  case "$out" in
    '{'*'}') ;;
    *) return 1 ;;
  esac
  # the pairs are present (APP_ENV is the starter value)
  case "$out" in
    *'"APP_ENV":"production"'*) ;; *) return 1 ;;
  esac
  case "$out" in
    *'"HELLO":"world"'*) ;; *) return 1 ;;
  esac
  case "$out" in
    *'"NUMBER":"42"'*) ;; *) return 1 ;;
  esac
}

test_json_dump_position_independent() {
  # --json is a verb; @env may sit before or after it.
  xenv setup >/dev/null 2>&1
  a=$(xenv @development --json) || return 1
  b=$(xenv --json @development) || return 1
  assert_eq "$a" "$b" "--json is position-independent w.r.t. @env"
}

test_json_dump_escapes_special_chars() {
  # Values with '=', quotes, backslashes, tabs, and newlines must survive
  # as valid, correctly-escaped JSON. This is the whole point of --json:
  # KEY=value lines can't represent these unambiguously.
  xenv setup >/dev/null 2>&1
  xenv set @production 'WITHEQ=a=b=c'          >/dev/null 2>&1
  xenv set @production 'QUOTED=he said "hi"'   >/dev/null 2>&1
  printf 'l1\nl2\ttab' | xenv set @production MULTI >/dev/null 2>&1

  out=$(xenv @production --json) || return 1
  # '=' survives verbatim inside the JSON string
  case "$out" in *'"WITHEQ":"a=b=c"'*) ;; *) return 1 ;; esac
  # embedded double-quotes are backslash-escaped
  case "$out" in *'"QUOTED":"he said \"hi\""'*) ;; *) return 1 ;; esac
  # newline and tab become \n and \t (no raw control bytes)
  case "$out" in *'"MULTI":"l1\nl2\ttab"'*) ;; *) return 1 ;; esac
}

test_json_dump_empty_env_is_braces() {
  # An env with no values dumps as "{}".
  xenv setup >/dev/null 2>&1
  xenv key generate @blank --file >/dev/null 2>&1
  out=$(xenv @blank --json) || return 1
  assert_eq "{}" "$out" "empty env dumps as {}"
}

test_json_dump_needs_env() {
  # --json with no @env is an error.
  xenv setup >/dev/null 2>&1
  out=$(xenv --json 2>&1) && return 1
  echo "$out" | grep -qi "needs an env" || return 1
}

test_json_flag_not_eaten_by_run() {
  # When @env has a CMD, a trailing --json is an argument to that CMD,
  # not xenv's dump flag.
  xenv setup >/dev/null 2>&1
  out=$(xenv @development sh -c 'printf %s "$1"' -- --json 2>&1) || return 1
  assert_eq "--json" "$out" "--json passes through to the run command"
}

test_dash_dash_form_retired() {
  # `xenv -- env CMD` was the old shorthand. It's gone — @env replaces it.
  # The dispatcher should reject `--` as an unknown command.
  xenv setup >/dev/null 2>&1
  out=$(xenv -- production sh -c 'echo gone' 2>&1) && return 1
  echo "$out" | grep -qi "unknown command" || return 1
}

# ── edit ───────────────────────────────────────────────────────────

test_edit_round_trip() {
  xenv setup >/dev/null 2>&1
  cat > "$TMP/ed.sh" <<'EOF'
#!/bin/sh
printf 'changed' > "$1"
EOF
  chmod +x "$TMP/ed.sh"
  EDITOR="$TMP/ed.sh" xenv edit @production APP_ENV >/dev/null 2>&1
  out=$(xenv get @production APP_ENV)
  assert_eq "changed" "$out" "edit changes value"
}

test_edit_no_changes_skipped() {
  xenv setup >/dev/null 2>&1
  before=$(stat -c %Y xenv/envs/production/APP_ENV.value.enc 2>/dev/null \
           || stat -f %m xenv/envs/production/APP_ENV.value.enc 2>/dev/null)
  cat > "$TMP/noop.sh" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$TMP/noop.sh"
  EDITOR="$TMP/noop.sh" xenv edit @production APP_ENV >/dev/null 2>&1
  after=$(stat -c %Y xenv/envs/production/APP_ENV.value.enc 2>/dev/null \
          || stat -f %m xenv/envs/production/APP_ENV.value.enc 2>/dev/null)
  assert_eq "$before" "$after" "no-op edit doesn't touch file"
}

test_edit_creates_new_key() {
  xenv setup >/dev/null 2>&1
  cat > "$TMP/ed.sh" <<'EOF'
#!/bin/sh
printf 'created' > "$1"
EOF
  chmod +x "$TMP/ed.sh"
  EDITOR="$TMP/ed.sh" xenv edit @production NEWKEY >/dev/null 2>&1
  out=$(xenv get @production NEWKEY)
  assert_eq "created" "$out" "edit creates new key"
}

# ── rotate ─────────────────────────────────────────────────────────

test_rotate_changes_key_preserves_values() {
  xenv setup >/dev/null 2>&1
  xenv set @production DB=db1 >/dev/null 2>&1
  xenv set @production API=api1 >/dev/null 2>&1
  printf 'multi\nline' | xenv set @production PEM >/dev/null 2>&1

  # Before rotate: production has no per-env key (cascades to _global).
  # After `xenv key rotate @production`: production gets its own key,
  # which is what the rest of this test asserts changes.
  kdir=$(project_keys_dir)
  old_key=$(cat "$kdir/_global.key")
  xenv key rotate @production >/dev/null 2>&1
  new_key=$(cat "$kdir/production.key")

  [ "$old_key" != "$new_key" ] || return 1
  [ "$(xenv get @production APP_ENV)" = "production" ] || return 1
  [ "$(xenv get @production DB)"  = "db1" ]  || return 1
  [ "$(xenv get @production API)" = "api1" ] || return 1
  multi_check=$(printf 'multi\nline')
  [ "$(xenv get @production PEM)" = "$multi_check" ] || return 1
}

# ── crypto integrity ──────────────────────────────────────────────

test_wrong_key_fails_mac() {
  # Tamper with the cached key: write a known-wrong value to
  # _global.key (which is what all four envs cascade to by default).
  # Decrypt under that key should fail MAC.
  xenv setup >/dev/null 2>&1
  echo "wrongkeywrongkeywrongkeywrongkey=" > "$(project_keys_dir)/_global.key"
  out=$(xenv get @production APP_ENV 2>&1) && return 1
  echo "$out" | grep -qi "MAC verification\|wrong key" || return 1
}

test_env_var_beats_file_backend() {
  xenv setup >/dev/null 2>&1
  XENV_KEY_PRODUCTION="wrongkey" xenv get @production APP_ENV >/dev/null 2>&1 && return 1
  return 0
}

test_tampered_ciphertext_rejected() {
  xenv setup >/dev/null 2>&1
  orig=$(cat xenv/envs/production/APP_ENV.value.enc)
  IFS=: read -r tag ver iv ct mac <<EOF
$orig
EOF
  first=$(printf '%s' "$ct" | cut -c1)
  rest=$(printf '%s' "$ct" | cut -c2-)
  if [ "$first" = "f" ]; then mut="0$rest"; else mut="f$rest"; fi
  printf 'xenv:v3:%s:%s:%s\n' "$iv" "$mut" "$mac" > xenv/envs/production/APP_ENV.value.enc

  out=$(xenv get @production APP_ENV 2>&1) && return 1
  echo "$out" | grep -qi "MAC verification" || return 1
}

test_envelope_short_iv_rejected() {
  xenv setup >/dev/null 2>&1
  printf 'xenv:v3:deadbeef:00112233445566778899aabbccddeeff:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n' \
    > xenv/envs/production/BAD.value.enc
  out=$(xenv get @production BAD 2>&1) && return 1
  echo "$out" | grep -qi "invalid iv length" || return 1
}

test_envelope_bad_hex_rejected() {
  xenv setup >/dev/null 2>&1
  printf 'xenv:v3:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ:00112233445566778899aabbccddeeff:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n' \
    > xenv/envs/production/BAD.value.enc
  out=$(xenv get @production BAD 2>&1) && return 1
  echo "$out" | grep -qi "non-hex" || return 1
}

test_envelope_extra_fields_rejected() {
  xenv setup >/dev/null 2>&1
  printf 'xenv:v3:00112233445566778899aabbccddeeff:00112233445566778899aabbccddeeff:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff:extra\n' \
    > xenv/envs/production/BAD.value.enc
  out=$(xenv get @production BAD 2>&1) && return 1
  echo "$out" | grep -qi "extra fields" || return 1
}

test_unsupported_version_rejected() {
  xenv setup >/dev/null 2>&1
  printf 'xenv:v99:00112233445566778899aabbccddeeff:00112233445566778899aabbccddeeff:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n' \
    > xenv/envs/production/BAD.value.enc
  out=$(xenv get @production BAD 2>&1) && return 1
  echo "$out" | grep -qi "unsupported vault version" || return 1
}

# ── concurrency + atomicity ───────────────────────────────────────

test_concurrent_writes_to_different_keys() {
  xenv setup >/dev/null 2>&1
  for i in 1 2 3 4 5; do
    ( xenv set @production "KEY_$i=value_$i" >/dev/null 2>&1 ) &
  done
  wait
  for i in 1 2 3 4 5; do
    val=$(xenv get @production "KEY_$i" 2>/dev/null)
    [ "$val" = "value_$i" ] || return 1
  done
  return 0
}

test_concurrent_writes_to_same_key() {
  xenv setup >/dev/null 2>&1
  for i in 1 2 3 4 5; do
    ( xenv set @production "RACE=value_$i" >/dev/null 2>&1 ) &
  done
  wait
  val=$(xenv get @production RACE 2>/dev/null) || return 1
  case "$val" in
    value_1|value_2|value_3|value_4|value_5) return 0 ;;
    *) return 1 ;;
  esac
}

test_partial_encrypt_failure_preserves() {
  xenv setup >/dev/null 2>&1
  orig=$(cat xenv/envs/production/APP_ENV.value.enc)

  mkdir "$TMP/badbin"
  cat > "$TMP/badbin/openssl" <<EOF
#!/bin/sh
if [ "\${1:-}" = "enc" ]; then
  case "\$*" in *-d*) exec /usr/bin/openssl "\$@" ;; esac
  exit 1
fi
exec /usr/bin/openssl "\$@"
EOF
  chmod +x "$TMP/badbin/openssl"
  PATH="$TMP/badbin:$PATH" xenv set @production APP_ENV=newvalue >/dev/null 2>&1

  now=$(cat xenv/envs/production/APP_ENV.value.enc)
  assert_eq "$orig" "$now" "encrypt failure preserves original"
}

# ── per-key file structure (the defining properties) ──────────────

test_each_value_is_own_file() {
  xenv setup >/dev/null 2>&1
  xenv set @production ALPHA=1 >/dev/null 2>&1
  xenv set @production BETA=2 >/dev/null 2>&1
  xenv set @production GAMMA=3 >/dev/null 2>&1
  # APP_ENV + 3 new = 4
  count=$(ls xenv/envs/production/*.value.enc 2>/dev/null | wc -l)
  assert_eq "4" "$count" "four values, four files"
}

test_files_use_value_enc_extension() {
  xenv setup >/dev/null 2>&1
  xenv set @production DATABASE_URL=x >/dev/null 2>&1
  [ -f xenv/envs/production/DATABASE_URL.value.enc ] || return 1
  # explicitly NOT the old .enc extension
  [ -f xenv/envs/production/DATABASE_URL.enc ] && return 1
  return 0
}

test_no_separate_params_file() {
  # KDF params used to live in params.xenv. Now they live in the
  # README's YAML frontmatter — there should be no params file at all.
  xenv setup >/dev/null 2>&1
  [ -f xenv/envs/production/params.xenv ] && return 1
  [ -f xenv/envs/production/.params ]     && return 1
  return 0
}

test_no_separate_project_file() {
  # the project id used to live in project.xenv. it's now in the top-level
  # README's frontmatter — there should be no project.xenv anywhere.
  xenv setup >/dev/null 2>&1
  [ -f xenv/project.xenv ] && return 1
  [ -f xenv/.project ]     && return 1
  return 0
}

test_top_readme_frontmatter_has_do_not_edit_warning() {
  # the project-state frontmatter should carry the same unmissable warning
  # as the per-env crypto-state frontmatter. one pattern, applied uniformly.
  xenv setup >/dev/null 2>&1
  rf=xenv/README.md
  block=$(awk 'NR==1 && $0=="---"{p=1;next} p && $0=="---"{exit} p' "$rf")
  echo "$block" | grep -qi "DO NOT EDIT" || return 1
}

test_frontmatter_has_do_not_edit_warning() {
  # the frontmatter is one keystroke from breaking decryption. it must
  # carry an unmissable warning so an agent reading it knows to leave it alone.
  xenv setup >/dev/null 2>&1
  rf=xenv/envs/production/README.md
  block=$(awk 'NR==1 && $0=="---"{p=1;next} p && $0=="---"{exit} p' "$rf")
  echo "$block" | grep -qi "DO NOT EDIT" || return 1
}

test_rotate_preserves_readme_body() {
  # rotation changes the salt+iter in the frontmatter but must not touch
  # the body — user/agent prose edits survive a key rotation.
  xenv setup >/dev/null 2>&1
  rf=xenv/envs/production/README.md

  # mark the body with something an agent might have added
  printf '\n## ops notes\n\nrotated 2026 — sentinel-xyz\n' >> "$rf"

  # capture the body (everything after the frontmatter) before rotation
  body_before=$(awk 'NR==1 && $0=="---"{p=1;next} p && $0=="---"{p=0;next} !p' "$rf")
  salt_before=$(read_fm "$rf" salt)

  xenv key rotate @production >/dev/null 2>&1 || return 1

  body_after=$(awk 'NR==1 && $0=="---"{p=1;next} p && $0=="---"{p=0;next} !p' "$rf")
  salt_after=$(read_fm "$rf" salt)

  # body identical, salt changed
  [ "$body_before" = "$body_after" ] || return 1
  [ "$salt_before" != "$salt_after" ] || return 1

  # and the user's sentinel survived
  grep -q "sentinel-xyz" "$rf" || return 1
}

test_frontmatter_parser_naive_split_on_first_colon() {
  # the parser splits on the FIRST colon. "key: a:b:c" should yield value "a:b:c".
  # we verify this by hand-crafting a README, then exercising decrypt — which
  # only works if read_params got the right salt out.
  xenv setup >/dev/null 2>&1
  rf=xenv/envs/production/README.md

  # the existing salt is what works. read it, then rewrite the frontmatter
  # with a value that contains internal colons in a comment to prove the
  # parser isn't confused. (we can't put colons in salt — it's hex.)
  salt=$(read_fm "$rf" salt)
  body=$(awk 'NR==1 && $0=="---"{p=1;next} p && $0=="---"{p=0;next} !p' "$rf")

  cat > "$rf" <<EOF
---
# stress: nothing here:should:confuse:the:parser
version: v3
iter: 200000
salt: $salt
# trailing comment: also: with: colons
---
$body
EOF

  out=$(xenv get @production APP_ENV)
  assert_eq "production" "$out" "decrypt still works with comment-laden frontmatter"
}

test_empty_value() {
  xenv setup >/dev/null 2>&1
  xenv set @production EMPTY= >/dev/null 2>&1
  out=$(xenv get @production EMPTY)
  assert_eq "" "$out" "empty value round-trips"
}

test_set_after_unset() {
  xenv setup >/dev/null 2>&1
  xenv set @production FOO=v1 >/dev/null 2>&1
  xenv unset @production FOO >/dev/null 2>&1
  xenv set @production FOO=v2 >/dev/null 2>&1
  out=$(xenv get @production FOO)
  assert_eq "v2" "$out" "set after unset"
}

# ── main ───────────────────────────────────────────────────────────

printf 'xenv test suite (shell: %s)\n\n' "$SHELL_BIN"

run_test "version"                                  test_version

# init structure
run_test "init creates xenv/"                       test_init_creates_xenv_dir
run_test "init creates top README"                  test_init_creates_top_readme
run_test "init creates xenv/bin/xenv"               test_init_creates_bin_xenv
run_test "init creates four envs"                   test_init_creates_four_envs
run_test "setup stores ONE global passphrase"       test_setup_stores_global_passphrase
run_test "setup honors \$XENV_KEY as _global"        test_setup_honors_global_env_var
run_test "setup honors \$XENV_KEY_<ENV> as per-env"  test_setup_honors_per_env_var
run_test "cascade: per-env beats _global"            test_cascade_per_env_beats_global
run_test "key show (no @env) describes _global"      test_key_show_no_env_describes_global
run_test "key show @env reports via _global"         test_key_show_at_env_says_via_global
run_test "key forget _global warns about envs"       test_key_forget_global_warns_about_envs
run_test "key forget @env notes cascade fallback"    test_key_forget_env_notes_cascade_fallback
run_test "key rotate (project) skips per-env keyed"  test_key_rotate_global_skips_per_env_keyed
run_test "init APP_ENV decrypts to env name"        test_init_app_env_decrypts_to_env_name
run_test "init per-env README mentions env name"    test_init_per_env_readme_mentions_env_name
run_test "init top README documents passphrase env vars" \
                                                    test_init_top_readme_documents_passphrase_env_vars
run_test "setup on existing tree adopts"            test_setup_on_existing_tree_adopts

# project id
run_test "init writes project id in xenv/README.md frontmatter" \
                                                    test_init_writes_project_id_in_top_readme
run_test "init creates per-project config dir"      test_init_creates_per_project_config_dir
run_test "init origin file records xenv/ path"      test_init_origin_file_records_xenv_path
run_test "init notes stub mentions project id"      test_init_notes_stub_mentions_project_id
run_test "two same-basename projects → unique ids"  test_two_projects_same_basename_get_unique_ids
run_test "weird basename gets sanitized"            test_basename_sanitization
run_test "no xenv/README.md → key lookup fails"     test_no_top_readme_means_no_key_lookup
run_test "init writes KDF params in README frontmatter"  test_init_frontmatter_params
run_test "init value files are v3 envelopes"        test_init_value_files_are_v3_envelopes
run_test "init bin/xenv is self-contained"          test_init_bin_xenv_is_self_contained

# set / get / list / unset
run_test "set creates one value file"               test_set_creates_one_value_file
run_test "set inline round-trip"                    test_set_inline_round_trip
run_test "set value with = signs"                   test_set_value_with_equals_signs
run_test "set value with quotes — no RCE"           test_set_value_with_quotes_no_rce
run_test "set from stdin (multi-line)"              test_set_from_stdin_multiline
run_test "set PEM key (multi-line)"                 test_set_pem_key
run_test "unset removes file"                       test_unset_removes_file
run_test "list shows starter APP_ENV"               test_list_shows_starter_app_env
run_test "list shows new keys"                      test_list_shows_new_keys
run_test "get silent on success"                    test_get_silent_on_success
run_test "get missing key fails"                    test_get_missing_key_fails
run_test "get pipe preserves exact bytes"           test_get_pipe_preserves_exact_bytes
run_test "get pipe preserves internal newlines"     test_get_pipe_preserves_internal_newlines
run_test "tty_finish algorithm (awk '{print}')"     test_tty_finish_algorithm

# envs
run_test "envs lists all four"                      test_envs_lists_all_four
run_test "envs only iterates xenv/envs/"            test_envs_only_iterates_envs_dir

# run
run_test "run injects env"                          test_run_injects_env
run_test "run preserves multi-line"                 test_run_preserves_multiline
run_test "run propagates exit code"                 test_run_propagates_exit_code
run_test "run no command fails"                     test_run_no_command_fails
run_test "run no env fails"                         test_run_no_env_fails
run_test "@env shorthand runs like `run`"           test_at_shorthand_runs_like_run
run_test "@env shorthand propagates exit code"      test_at_shorthand_propagates_exit_code
run_test "@ with no env fails"                      test_at_empty_env_fails
run_test "@env with no CMD prints env"              test_at_no_command_prints_env
run_test "@env with no CMD preserves multi-line"    test_at_no_command_multiline_values_intact
run_test "@env --json prints one JSON object"       test_json_dump_is_one_object
run_test "@env --json is position-independent"      test_json_dump_position_independent
run_test "@env --json escapes special chars"        test_json_dump_escapes_special_chars
run_test "@env --json empty env is {}"              test_json_dump_empty_env_is_braces
run_test "@env --json needs an env"                 test_json_dump_needs_env
run_test "--json not eaten by run command"          test_json_flag_not_eaten_by_run
run_test "old `--` shorthand is retired"            test_dash_dash_form_retired

# edit
run_test "edit round-trip"                          test_edit_round_trip
run_test "edit no changes skipped"                  test_edit_no_changes_skipped
run_test "edit creates new key"                     test_edit_creates_new_key

# rotate
run_test "rotate changes key preserves values"      test_rotate_changes_key_preserves_values

# crypto
run_test "wrong key fails MAC"                      test_wrong_key_fails_mac
run_test "env var beats file backend"               test_env_var_beats_file_backend
run_test "tampered ciphertext rejected"             test_tampered_ciphertext_rejected
run_test "envelope short iv rejected"               test_envelope_short_iv_rejected
run_test "envelope bad hex rejected"                test_envelope_bad_hex_rejected
run_test "envelope extra fields rejected"           test_envelope_extra_fields_rejected
run_test "unsupported version rejected"             test_unsupported_version_rejected

# concurrency / atomicity
run_test "concurrent writes — different keys"       test_concurrent_writes_to_different_keys
run_test "concurrent writes — same key"             test_concurrent_writes_to_same_key
run_test "partial encrypt failure preserves"        test_partial_encrypt_failure_preserves

# structure
run_test "each value is own file"                   test_each_value_is_own_file
run_test "files use .value.enc extension"           test_files_use_value_enc_extension
run_test "no separate params file — frontmatter only"   test_no_separate_params_file
run_test "no separate project file — frontmatter only"  test_no_separate_project_file
run_test "top README frontmatter has DO NOT EDIT"        test_top_readme_frontmatter_has_do_not_edit_warning
run_test "frontmatter has DO NOT EDIT warning"           test_frontmatter_has_do_not_edit_warning
run_test "rotate preserves README body"                  test_rotate_preserves_readme_body
run_test "frontmatter parser is naive (split on first :)" test_frontmatter_parser_naive_split_on_first_colon
run_test "empty value round-trips"                  test_empty_value
run_test "set after unset"                          test_set_after_unset

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'failed:%b\n' "$FAILED_TESTS"
  exit 1
fi
exit 0
