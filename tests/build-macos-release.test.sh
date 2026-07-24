#!/usr/bin/env bash
set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$test_dir/.." && pwd)"
build_script="$repo_root/build-macos-release.sh"

output=''
status=0

run_script() {
  set +e
  output="$("$build_script" "$@" 2>&1)"
  status=$?
  set -e
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  printf 'Captured status: %s\n' "$status" >&2
  printf 'Captured output:\n%s\n' "$output" >&2
  exit 1
}

assert_status() {
  local expected="$1"

  if [[ "$status" -ne "$expected" ]]; then
    fail "expected exit status $expected, got $status"
  fi
}

assert_output_contains() {
  local expected="$1"

  case "$output" in
    *"$expected"*) ;;
    *) fail "expected output to contain: $expected" ;;
  esac
}

run_test() {
  local name="$1"
  local test_function="$2"

  "$test_function"
  printf 'PASS: %s\n' "$name"
}

test_help() {
  run_script --help
  assert_status 0
  assert_output_contains '--target arm64|x86_64'
  assert_output_contains 'RapidRAW.app'
  assert_output_contains '.dmg'
}

test_target_requires_value() {
  run_script --target
  assert_status 2
  assert_output_contains '--target requires a value'
}

test_unsupported_target() {
  run_script --target powerpc
  assert_status 2
  assert_output_contains 'unsupported target: powerpc'
}

test_unknown_option() {
  run_script --sign
  assert_status 2
  assert_output_contains 'unknown option: --sign'
}

test_unexpected_positional_argument() {
  run_script output.dmg
  assert_status 2
  assert_output_contains 'unexpected argument: output.dmg'
}

test_duplicate_target() {
  run_script --target arm64 --target x86_64
  assert_status 2
  assert_output_contains '--target may only be specified once'
}

run_test 'help documents supported targets' test_help
run_test 'target requires a value' test_target_requires_value
run_test 'unsupported target is rejected' test_unsupported_target
run_test 'unknown option is rejected' test_unknown_option
run_test 'positional argument is rejected' test_unexpected_positional_argument
run_test 'target may only be specified once' test_duplicate_target
