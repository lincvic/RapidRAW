#!/usr/bin/env bash
set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$test_dir/.." && pwd)"
build_script="$repo_root/build-macos-release.sh"
toolchain_file="$repo_root/src-tauri/rust-toolchain.toml"
test_tmp_base="${TMPDIR:-/tmp}"
test_temp_root="$(mktemp -d "${test_tmp_base%/}/rapidraw-macos-build-tests.XXXXXX")"

trap 'rm -rf "$test_temp_root"' EXIT

output=''
status=0
fixture_root=''
fixture_repo=''
fixture_log=''
fixture_stub_bin=''
fixture_rustup_prefix=''
test_count=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  printf 'Captured status: %s\n' "$status" >&2
  printf 'Captured output:\n%s\n' "$output" >&2
  if [[ -n "$fixture_log" ]] && [[ -f "$fixture_log" ]]; then
    printf 'Command log:\n' >&2
    sed 's/^/  /' "$fixture_log" >&2
  fi
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

assert_log_contains() {
  local expected="$1"

  if ! grep -Fqx -- "$expected" "$fixture_log"; then
    fail "expected command log to contain exact line: $expected"
  fi
}

assert_log_not_contains() {
  local unexpected="$1"

  if grep -Fq -- "$unexpected" "$fixture_log"; then
    fail "expected command log not to contain: $unexpected"
  fi
}

assert_log_empty() {
  if [[ -s "$fixture_log" ]]; then
    fail 'expected command log to stay empty'
  fi
}

assert_directory_exists() {
  local path="$1"

  if [[ ! -d "$path" ]]; then
    fail "expected directory to exist: $path"
  fi
}

assert_file_exists() {
  local path="$1"

  if [[ ! -f "$path" ]]; then
    fail "expected file to exist: $path"
  fi
}

write_uname_stub() {
  cat > "$fixture_stub_bin/uname" <<'EOF'
#!/usr/bin/env bash
set -u

printf 'uname %s\n' "$*" >> "$TEST_COMMAND_LOG"

case "${1:-}" in
  -s)
    printf '%s\n' "$TEST_UNAME_SYSTEM"
    ;;
  -m)
    printf '%s\n' "$TEST_UNAME_MACHINE"
    ;;
  *)
    printf 'unexpected uname invocation: %s\n' "$*" >&2
    exit 64
    ;;
esac
EOF
}

write_sysctl_stub() {
  cat > "$fixture_stub_bin/sysctl" <<'EOF'
#!/usr/bin/env bash
set -u

printf 'sysctl %s\n' "$*" >> "$TEST_COMMAND_LOG"

if [[ "$*" != '-in sysctl.proc_translated' ]]; then
  printf 'unexpected sysctl invocation: %s\n' "$*" >&2
  exit 64
fi

if [[ "$TEST_SYSCTL_STATUS" -ne 0 ]]; then
  exit "$TEST_SYSCTL_STATUS"
fi

printf '%s\n' "$TEST_PROC_TRANSLATED"
EOF
}

write_brew_stub() {
  cat > "$fixture_stub_bin/brew" <<'EOF'
#!/usr/bin/env bash
set -u

printf 'brew %s\n' "$*" >> "$TEST_COMMAND_LOG"

if [[ "$*" != '--prefix rustup' ]]; then
  printf 'unexpected brew invocation: %s\n' "$*" >&2
  exit 64
fi

printf '%s\n' "$TEST_RUSTUP_PREFIX"
EOF
}

write_standalone_rust_stubs() {
  cat > "$fixture_stub_bin/cargo" <<'EOF'
#!/usr/bin/env bash
printf 'standalone cargo\n' >> "$TEST_COMMAND_LOG"
exit 90
EOF

  cat > "$fixture_stub_bin/rustc" <<'EOF'
#!/usr/bin/env bash
printf 'standalone rustc\n' >> "$TEST_COMMAND_LOG"
exit 91
EOF
}

write_rustup_stub() {
  cat > "$fixture_rustup_prefix/bin/rustup" <<'EOF'
#!/usr/bin/env bash
set -u

printf 'rustup' >> "$TEST_COMMAND_LOG"
printf ' %s' "$@" >> "$TEST_COMMAND_LOG"
printf '\n' >> "$TEST_COMMAND_LOG"

if [[ "$#" -eq 6 ]] && [[ "$1" == 'toolchain' ]] && [[ "$2" == 'install' ]] && \
   [[ "$3" == "$TEST_EXPECTED_TOOLCHAIN" ]] && [[ "$4" == '--no-self-update' ]] && \
   [[ "$5" == '--profile' ]] && [[ "$6" == 'minimal' ]]; then
  exit 0
fi

if [[ "$#" -eq 5 ]] && [[ "$1" == 'target' ]] && [[ "$2" == 'add' ]] && \
   [[ "$3" == '--toolchain' ]] && [[ "$4" == "$TEST_EXPECTED_TOOLCHAIN" ]]; then
  case "$5" in
    aarch64-apple-darwin|x86_64-apple-darwin) exit 0 ;;
  esac
fi

if [[ "$#" -eq 4 ]] && [[ "$1" == 'run' ]] && [[ "$2" == "$TEST_EXPECTED_TOOLCHAIN" ]] && \
   [[ "$4" == '--version' ]]; then
  case "$3" in
    cargo)
      printf 'cargo 1.96.1 (fixture)\n'
      exit 0
      ;;
    rustc)
      printf 'rustc 1.96.1 (fixture)\n'
      exit 0
      ;;
  esac
fi

printf 'unexpected rustup invocation: %s\n' "$*" >&2
exit 64
EOF
}

write_rustup_proxy_stubs() {
  cat > "$fixture_rustup_prefix/bin/cargo" <<'EOF'
#!/usr/bin/env bash
set -u

printf 'proxy cargo RUSTUP_TOOLCHAIN=%s' "${RUSTUP_TOOLCHAIN:-}" >> "$TEST_COMMAND_LOG"
printf ' %s' "$@" >> "$TEST_COMMAND_LOG"
printf '\n' >> "$TEST_COMMAND_LOG"

if [[ "${RUSTUP_TOOLCHAIN:-}" != "$TEST_EXPECTED_TOOLCHAIN" ]] || [[ "$*" != '--version' ]]; then
  exit 64
fi

if [[ "$TEST_PROXY_VERSION_MISMATCH" -eq 1 ]]; then
  printf 'cargo 0.0.0 (mismatch)\n'
else
  printf 'cargo 1.96.1 (fixture)\n'
fi
EOF

  cat > "$fixture_rustup_prefix/bin/rustc" <<'EOF'
#!/usr/bin/env bash
set -u

printf 'proxy rustc RUSTUP_TOOLCHAIN=%s' "${RUSTUP_TOOLCHAIN:-}" >> "$TEST_COMMAND_LOG"
printf ' %s' "$@" >> "$TEST_COMMAND_LOG"
printf '\n' >> "$TEST_COMMAND_LOG"

if [[ "${RUSTUP_TOOLCHAIN:-}" != "$TEST_EXPECTED_TOOLCHAIN" ]] || [[ "$*" != '--version' ]]; then
  exit 64
fi

printf 'rustc 1.96.1 (fixture)\n'
EOF
}

write_npm_stub() {
  cat > "$fixture_stub_bin/npm" <<'EOF'
#!/usr/bin/env bash
set -u

printf 'npm env RUSTUP_TOOLCHAIN=%s\n' "${RUSTUP_TOOLCHAIN:-}" >> "$TEST_COMMAND_LOG"
printf 'npm' >> "$TEST_COMMAND_LOG"
printf ' %s' "$@" >> "$TEST_COMMAND_LOG"
printf '\n' >> "$TEST_COMMAND_LOG"

if [[ "$#" -eq 1 ]] && [[ "$1" == 'install' ]]; then
  exit 0
fi

if [[ "$#" -ne 10 ]] || [[ "$1" != 'run' ]] || [[ "$2" != 'tauri' ]] || \
   [[ "$3" != '--' ]] || [[ "$4" != 'build' ]] || [[ "$5" != '--verbose' ]] || \
   [[ "$6" != '--target' ]] || [[ "$8" != '--bundles' ]] || [[ "$9" != 'app,dmg' ]] || \
   [[ "${10}" != '--no-sign' ]]; then
  printf 'unexpected npm invocation: %s\n' "$*" >&2
  exit 64
fi

target_triple="$7"
bundle_dir="src-tauri/target/$target_triple/release/bundle"

case "$TEST_ARTIFACT_MODE" in
  all)
    mkdir -p "$bundle_dir/macos/RapidRAW.app" "$bundle_dir/dmg"
    : > "$bundle_dir/dmg/RapidRAW-test.dmg"
    ;;
  app)
    mkdir -p "$bundle_dir/macos/RapidRAW.app"
    ;;
  none)
    ;;
  *)
    printf 'unsupported fixture artifact mode: %s\n' "$TEST_ARTIFACT_MODE" >&2
    exit 64
    ;;
esac
EOF
}

setup_fixture() {
  fixture_root="$(mktemp -d "$test_temp_root/case.XXXXXX")"
  fixture_repo="$fixture_root/repo"
  fixture_stub_bin="$fixture_root/stub-bin"
  fixture_rustup_prefix="$fixture_root/homebrew-rustup"
  fixture_log="$fixture_root/commands.log"

  mkdir -p "$fixture_repo/src-tauri" "$fixture_stub_bin" "$fixture_rustup_prefix/bin" "$fixture_root/caller"
  cp "$build_script" "$fixture_repo/build-macos-release.sh"
  cp "$toolchain_file" "$fixture_repo/src-tauri/rust-toolchain.toml"
  chmod +x "$fixture_repo/build-macos-release.sh"
  : > "$fixture_log"

  case "${TEST_TOOLCHAIN_MODE:-valid}" in
    valid) ;;
    missing)
      cat > "$fixture_repo/src-tauri/rust-toolchain.toml" <<'EOF'
[toolchain]
profile = "minimal"
EOF
      ;;
    empty)
      cat > "$fixture_repo/src-tauri/rust-toolchain.toml" <<'EOF'
[toolchain]
channel = ""
EOF
      ;;
    ambiguous)
      cat > "$fixture_repo/src-tauri/rust-toolchain.toml" <<'EOF'
[toolchain]
channel = "1.96.1"
channel = "stable"
EOF
      ;;
    *) fail "unsupported fixture toolchain mode: ${TEST_TOOLCHAIN_MODE:-}" ;;
  esac

  write_uname_stub
  write_sysctl_stub
  write_standalone_rust_stubs
  write_rustup_stub
  write_rustup_proxy_stubs

  if [[ "${TEST_MISSING_BREW:-0}" -ne 1 ]]; then
    write_brew_stub
  fi
  if [[ "${TEST_MISSING_NPM:-0}" -ne 1 ]]; then
    write_npm_stub
  fi
  if [[ "${TEST_MISSING_RUSTUP_PROXY:-0}" -eq 1 ]]; then
    rm "$fixture_rustup_prefix/bin/rustup"
  fi

  chmod +x "$fixture_stub_bin"/* "$fixture_rustup_prefix/bin"/*
}

run_fixture() {
  setup_fixture

  set +e
  output="$(
    cd "$fixture_root/caller"
    env -i \
      PATH="$fixture_stub_bin:/usr/bin:/bin" \
      RUSTUP_TOOLCHAIN="${TEST_INHERITED_TOOLCHAIN:-stable}" \
      TEST_COMMAND_LOG="$fixture_log" \
      TEST_UNAME_SYSTEM="${TEST_UNAME_SYSTEM:-Darwin}" \
      TEST_UNAME_MACHINE="${TEST_UNAME_MACHINE:-arm64}" \
      TEST_PROC_TRANSLATED="${TEST_PROC_TRANSLATED:-0}" \
      TEST_SYSCTL_STATUS="${TEST_SYSCTL_STATUS:-0}" \
      TEST_RUSTUP_PREFIX="$fixture_rustup_prefix" \
      TEST_EXPECTED_TOOLCHAIN='1.96.1' \
      TEST_PROXY_VERSION_MISMATCH="${TEST_PROXY_VERSION_MISMATCH:-0}" \
      TEST_ARTIFACT_MODE="${TEST_ARTIFACT_MODE:-all}" \
      "$fixture_repo/build-macos-release.sh" "$@" 2>&1
  )"
  status=$?
  set -e
}

run_test() {
  local name="$1"
  local test_function="$2"

  "$test_function"
  test_count=$((test_count + 1))
  printf 'PASS: %s\n' "$name"
}

test_help() {
  run_fixture --help
  assert_status 0
  assert_output_contains '--target arm64|x86_64'
  assert_output_contains 'RapidRAW.app'
  assert_output_contains '.dmg'
  assert_log_empty
}

test_target_requires_value() {
  run_fixture --target
  assert_status 2
  assert_output_contains '--target requires a value'
  assert_log_empty
}

test_unsupported_target() {
  run_fixture --target powerpc
  assert_status 2
  assert_output_contains 'unsupported target: powerpc'
  assert_log_empty
}

test_unknown_option() {
  run_fixture --sign
  assert_status 2
  assert_output_contains 'unknown option: --sign'
  assert_log_empty
}

test_unexpected_positional_argument() {
  run_fixture output.dmg
  assert_status 2
  assert_output_contains 'unexpected argument: output.dmg'
  assert_log_empty
}

test_duplicate_target() {
  run_fixture --target arm64 --target x86_64
  assert_status 2
  assert_output_contains '--target may only be specified once'
  assert_log_empty
}

test_help_rejects_trailing_unknown_option() {
  run_fixture --help --bad
  assert_status 2
  assert_output_contains 'unknown option: --bad'
  assert_log_empty
}

test_help_rejects_trailing_positional_argument() {
  run_fixture --help output.dmg
  assert_status 2
  assert_output_contains 'unexpected argument: output.dmg'
  assert_log_empty
}

test_help_rejects_duplicate_target() {
  run_fixture --help --target arm64 --target x86_64
  assert_status 2
  assert_output_contains '--target may only be specified once'
  assert_log_empty
}

test_help_accepts_valid_target() {
  run_fixture --help --target arm64
  assert_status 0
  assert_output_contains 'Usage: build-macos-release.sh'
  assert_log_empty
}

test_explicit_arm64_build() {
  run_fixture --target arm64
  assert_status 0
  assert_log_contains 'rustup toolchain install 1.96.1 --no-self-update --profile minimal'
  assert_log_contains 'rustup target add --toolchain 1.96.1 aarch64-apple-darwin'
  assert_log_contains 'proxy cargo RUSTUP_TOOLCHAIN=1.96.1 --version'
  assert_log_contains 'proxy rustc RUSTUP_TOOLCHAIN=1.96.1 --version'
  assert_log_contains 'rustup run 1.96.1 cargo --version'
  assert_log_contains 'rustup run 1.96.1 rustc --version'
  assert_log_not_contains 'standalone cargo'
  assert_log_not_contains 'standalone rustc'
  assert_log_contains 'npm install'
  assert_log_contains 'npm env RUSTUP_TOOLCHAIN=1.96.1'
  assert_log_contains 'npm run tauri -- build --verbose --target aarch64-apple-darwin --bundles app,dmg --no-sign'
  assert_output_contains 'Architecture: arm64'
  assert_output_contains 'Target: aarch64-apple-darwin'
  assert_output_contains 'Cargo: cargo 1.96.1 (fixture)'
  assert_output_contains 'Rustc: rustc 1.96.1 (fixture)'
  assert_output_contains "App: $fixture_repo/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/RapidRAW.app"
  assert_output_contains "DMG: $fixture_repo/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/RapidRAW-test.dmg"
  assert_directory_exists "$fixture_repo/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/RapidRAW.app"
  assert_file_exists "$fixture_repo/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/RapidRAW-test.dmg"
}

test_explicit_x86_64_build() {
  run_fixture --target x86_64
  assert_status 0
  assert_log_contains 'rustup target add --toolchain 1.96.1 x86_64-apple-darwin'
  assert_log_contains 'npm run tauri -- build --verbose --target x86_64-apple-darwin --bundles app,dmg --no-sign'
  assert_output_contains 'Architecture: x86_64'
  assert_output_contains 'Target: x86_64-apple-darwin'
}

test_default_native_arm64_build() {
  TEST_UNAME_MACHINE=arm64 run_fixture
  assert_status 0
  assert_log_contains 'uname -m'
  assert_log_not_contains 'sysctl '
  assert_output_contains 'Architecture: arm64'
  assert_output_contains 'Target: aarch64-apple-darwin'
}

test_rosetta_defaults_to_arm64() {
  TEST_UNAME_MACHINE=x86_64 TEST_PROC_TRANSLATED=1 run_fixture
  assert_status 0
  assert_log_contains 'sysctl -in sysctl.proc_translated'
  assert_output_contains 'Architecture: arm64'
  assert_output_contains 'Target: aarch64-apple-darwin'
}

test_native_intel_defaults_to_x86_64() {
  TEST_UNAME_MACHINE=x86_64 TEST_PROC_TRANSLATED=0 run_fixture
  assert_status 0
  assert_output_contains 'Architecture: x86_64'
  assert_output_contains 'Target: x86_64-apple-darwin'
}

test_unavailable_rosetta_sysctl_defaults_to_x86_64() {
  TEST_UNAME_MACHINE=x86_64 TEST_SYSCTL_STATUS=1 run_fixture
  assert_status 0
  assert_log_contains 'sysctl -in sysctl.proc_translated'
  assert_output_contains 'Architecture: x86_64'
  assert_output_contains 'Target: x86_64-apple-darwin'
}

test_inherited_toolchain_is_overridden() {
  TEST_INHERITED_TOOLCHAIN=stable run_fixture --target arm64
  assert_status 0
  assert_log_contains 'proxy cargo RUSTUP_TOOLCHAIN=1.96.1 --version'
  assert_log_contains 'proxy rustc RUSTUP_TOOLCHAIN=1.96.1 --version'
  assert_log_contains 'npm env RUSTUP_TOOLCHAIN=1.96.1'
  assert_log_not_contains 'RUSTUP_TOOLCHAIN=stable'
}

test_proxy_version_mismatch_fails_before_npm() {
  TEST_PROXY_VERSION_MISMATCH=1 run_fixture --target arm64
  assert_status 1
  assert_output_contains 'Error:'
  assert_output_contains 'Cargo version mismatch'
  assert_output_contains 'rustup proxy'
  assert_log_contains 'proxy cargo RUSTUP_TOOLCHAIN=1.96.1 --version'
  assert_log_not_contains 'npm '
}

test_non_darwin_fails_before_npm() {
  TEST_UNAME_SYSTEM=Linux run_fixture --target arm64
  assert_status 1
  assert_output_contains 'Error:'
  assert_output_contains 'macOS'
  assert_log_not_contains 'npm '
}

test_missing_npm_fails_before_npm() {
  TEST_MISSING_NPM=1 run_fixture --target arm64
  assert_status 1
  assert_output_contains 'Error:'
  assert_output_contains 'npm is required'
  assert_log_not_contains 'npm '
}

test_missing_brew_fails_before_npm() {
  TEST_MISSING_BREW=1 run_fixture --target arm64
  assert_status 1
  assert_output_contains 'Error:'
  assert_output_contains 'Homebrew is required'
  assert_log_not_contains 'npm '
}

test_missing_rustup_proxy_fails_before_npm() {
  TEST_MISSING_RUSTUP_PROXY=1 run_fixture --target arm64
  assert_status 1
  assert_output_contains 'Error:'
  assert_output_contains 'rustup proxy'
  assert_log_not_contains 'npm '
}

test_unsupported_native_architecture_fails_before_npm() {
  TEST_UNAME_MACHINE=powerpc run_fixture
  assert_status 1
  assert_output_contains 'Error:'
  assert_output_contains 'unsupported macOS host architecture: powerpc'
  assert_log_not_contains 'npm '
}

test_missing_toolchain_channel_fails_before_npm() {
  TEST_TOOLCHAIN_MODE=missing run_fixture --target arm64
  assert_status 1
  assert_output_contains 'Error:'
  assert_output_contains 'exactly one nonempty channel'
  assert_log_not_contains 'rustup toolchain install'
  assert_log_not_contains 'npm '
}

test_empty_toolchain_channel_fails_before_npm() {
  TEST_TOOLCHAIN_MODE=empty run_fixture --target arm64
  assert_status 1
  assert_output_contains 'Error:'
  assert_output_contains 'exactly one nonempty channel'
  assert_log_not_contains 'rustup toolchain install'
  assert_log_not_contains 'npm '
}

test_ambiguous_toolchain_channel_fails_before_npm() {
  TEST_TOOLCHAIN_MODE=ambiguous run_fixture --target arm64
  assert_status 1
  assert_output_contains 'Error:'
  assert_output_contains 'exactly one nonempty channel'
  assert_log_not_contains 'rustup toolchain install'
  assert_log_not_contains 'npm '
}

test_missing_dmg_fails_after_build() {
  TEST_ARTIFACT_MODE=app run_fixture --target arm64
  assert_status 1
  assert_output_contains 'Error:'
  assert_output_contains 'DMG artifact not found'
  assert_log_contains 'npm run tauri -- build --verbose --target aarch64-apple-darwin --bundles app,dmg --no-sign'
}

test_missing_app_fails_after_build() {
  TEST_ARTIFACT_MODE=none run_fixture --target arm64
  assert_status 1
  assert_output_contains 'Error:'
  assert_output_contains 'app artifact not found'
  assert_log_contains 'npm run tauri -- build --verbose --target aarch64-apple-darwin --bundles app,dmg --no-sign'
}

run_test 'help documents supported targets' test_help
run_test 'target requires a value' test_target_requires_value
run_test 'unsupported target is rejected' test_unsupported_target
run_test 'unknown option is rejected' test_unknown_option
run_test 'positional argument is rejected' test_unexpected_positional_argument
run_test 'target may only be specified once' test_duplicate_target
run_test 'help rejects a trailing unknown option' test_help_rejects_trailing_unknown_option
run_test 'help rejects a trailing positional argument' test_help_rejects_trailing_positional_argument
run_test 'help rejects a duplicate target' test_help_rejects_duplicate_target
run_test 'help accepts a valid target' test_help_accepts_valid_target
run_test 'explicit arm64 builds with pinned rustup proxies' test_explicit_arm64_build
run_test 'explicit x86_64 maps to the Intel target' test_explicit_x86_64_build
run_test 'native arm64 is the default target' test_default_native_arm64_build
run_test 'Rosetta defaults to the native arm64 target' test_rosetta_defaults_to_arm64
run_test 'native Intel defaults to x86_64' test_native_intel_defaults_to_x86_64
run_test 'unavailable Rosetta sysctl defaults to x86_64' test_unavailable_rosetta_sysctl_defaults_to_x86_64
run_test 'inherited rustup toolchain is overridden' test_inherited_toolchain_is_overridden
run_test 'proxy version mismatch fails before npm' test_proxy_version_mismatch_fails_before_npm
run_test 'non-Darwin hosts fail before npm' test_non_darwin_fails_before_npm
run_test 'missing npm fails before npm' test_missing_npm_fails_before_npm
run_test 'missing Homebrew fails before npm' test_missing_brew_fails_before_npm
run_test 'missing rustup proxy fails before npm' test_missing_rustup_proxy_fails_before_npm
run_test 'unsupported native architecture fails before npm' test_unsupported_native_architecture_fails_before_npm
run_test 'missing toolchain channel fails before npm' test_missing_toolchain_channel_fails_before_npm
run_test 'empty toolchain channel fails before npm' test_empty_toolchain_channel_fails_before_npm
run_test 'ambiguous toolchain channel fails before npm' test_ambiguous_toolchain_channel_fails_before_npm
run_test 'missing DMG fails after the build' test_missing_dmg_fails_after_build
run_test 'missing app fails after the build' test_missing_app_fails_after_build

printf 'All %s tests passed.\n' "$test_count"
