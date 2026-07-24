# macOS Release Build Script Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a root-level script that builds fresh, unsigned native or explicitly selected macOS `RapidRAW.app` and `.dmg` release artifacts with the repository-pinned Rust toolchain.

**Architecture:** A strict Bash entry point owns argument parsing, native/Rosetta architecture detection, Homebrew rustup proxy selection, dependency preparation, the local Tauri invocation, and fresh-artifact reporting. A standalone Bash test harness copies the entry point into a temporary fixture repository and substitutes deterministic command stubs, allowing orchestration and failure paths to be tested without compiling RapidRAW; one final native invocation verifies the real packaging path.

**Tech Stack:** Bash 3.2-compatible shell, Homebrew rustup, Rust 1.96.1 from `src-tauri/rust-toolchain.toml`, npm, Tauri CLI 2.11.4, macOS `find`/`sysctl`/`mktemp`.

---

## Working Agreement

- Repository: `/Users/laynewang/Documents/RustProjects/RapidRAW`
- Work only on `cl/vegdog/fix-raf-reading`.
- Keep `main` and `fork-dev` unchanged.
- Push only to `https://github.com/lincvic/RapidRAW`.
- Never push to `CyberTimon` and never create a pull request to the original repository.
- Build one architecture per invocation. Do not add signing, notarization, universal binaries, uploads, release creation, or artifact renaming.
- Follow @test-driven-development for implementation, @requesting-code-review before integration, and @verification-before-completion before any completion claim.
- Approved design: `docs/superpowers/specs/2026-07-24-macos-release-build-script-design.md`.

## File Map

- Create `/Users/laynewang/Documents/RustProjects/RapidRAW/build-macos-release.sh`: public build command; owns CLI validation, host/target resolution, pinned toolchain activation, Tauri packaging, and fresh bundle reporting.
- Create `/Users/laynewang/Documents/RustProjects/RapidRAW/tests/build-macos-release.test.sh`: dependency-free shell regression harness; owns command stubs and assertions for all behavior that does not require a real compile.

## Chunk 1: Local macOS Release Builder

### Task 1: Implement The Command Interface

**Files:**

- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/tests/build-macos-release.test.sh`
- Create: `/Users/laynewang/Documents/RustProjects/RapidRAW/build-macos-release.sh`

- [ ] **Step 1: Write failing CLI contract tests**

Create the test harness with strict mode, a temporary directory cleaned by `trap`, and small `fail`, `assert_status`, `assert_contains`, and `assert_empty` helpers. Run the repository script while capturing combined output and status without aborting the harness:

```bash
run_script() {
  set +e
  command_output="$("$script_path" "$@" 2>&1)"
  command_status=$?
  set -e
}
```

Cover these cases in named test functions:

```bash
test_help() {
  run_script --help
  assert_status 0
  assert_contains "$command_output" "--target arm64|x86_64"
}

test_missing_target_value() {
  run_script --target
  assert_status 2
  assert_contains "$command_output" "--target requires a value"
}

test_unsupported_target() {
  run_script --target powerpc
  assert_status 2
  assert_contains "$command_output" "unsupported target: powerpc"
}

test_unknown_option() {
  run_script --sign
  assert_status 2
  assert_contains "$command_output" "unknown option: --sign"
}

test_extra_argument() {
  run_script output.dmg
  assert_status 2
  assert_contains "$command_output" "unexpected argument: output.dmg"
}

test_duplicate_target() {
  run_script --target arm64 --target x86_64
  assert_status 2
  assert_contains "$command_output" "--target may only be specified once"
}
```

Have `main` execute every test and print `PASS: <name>` after each successful function. Do not introduce Bats, ShellCheck, shfmt, or an npm dependency for this repository-local harness.

- [ ] **Step 2: Run the CLI tests and verify RED**

Run:

```bash
bash tests/build-macos-release.test.sh
```

Expected: nonzero with a clear failure because `build-macos-release.sh` does not exist.

- [ ] **Step 3: Add the minimal strict CLI entry point**

Create an executable Bash 3.2-compatible file beginning with:

```bash
#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: build-macos-release.sh [--target arm64|x86_64]

Build unsigned RapidRAW.app and .dmg release artifacts for macOS.

Options:
  --target arm64|x86_64  Build for the selected architecture (default: native Mac)
  -h, --help             Show this help
EOF
}

usage_error() {
  printf 'Error: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}
```

Parse only `-h`, `--help`, and one separated `--target arm64|x86_64` option. Detect a missing value when no argument follows or the next token begins with `-`. Reject duplicates, unknown options, and positional arguments before running any prerequisite or build command. Store the accepted architecture in `requested_arch`; the script may end successfully after parsing for this first task.

- [ ] **Step 4: Verify the CLI contract is GREEN**

Run:

```bash
bash -n build-macos-release.sh
bash -n tests/build-macos-release.test.sh
bash tests/build-macos-release.test.sh
./build-macos-release.sh --help
```

Expected: both syntax checks pass, all six harness cases print `PASS`, and help exits zero with both supported target values.

- [ ] **Step 5: Commit the tested interface**

```bash
chmod +x build-macos-release.sh tests/build-macos-release.test.sh
git add build-macos-release.sh tests/build-macos-release.test.sh
git commit -m "feat(build): add macOS release script interface"
```

### Task 2: Orchestrate The Pinned Unsigned Tauri Build

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/tests/build-macos-release.test.sh`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/build-macos-release.sh`

- [ ] **Step 1: Add a deterministic fake-build fixture**

Extend the harness with `setup_fixture`, which creates a temporary repository containing a copied `build-macos-release.sh`, `src-tauri/rust-toolchain.toml`, a command-log file, a normal stub directory, and a separate fake Homebrew rustup prefix. Prepend only the normal stub directory initially so the test can prove the production script later prepends the rustup prefix.

Create executable stubs with these contracts:

- `uname -s` prints `Darwin`; `uname -m` prints `$TEST_UNAME_MACHINE` (default `arm64`).
- `sysctl -in sysctl.proc_translated` prints `$TEST_PROC_TRANSLATED` (default `0`) and exits with `$TEST_SYSCTL_STATUS` (default `0`).
- `brew --prefix rustup` prints `$TEST_RUSTUP_PREFIX`.
- Standalone `cargo` and `rustc` stubs fail and append `standalone cargo` or `standalone rustc` to `$TEST_COMMAND_LOG`.
- Rustup-prefix `rustup toolchain install <channel> --no-self-update --profile minimal` and `rustup target add --toolchain <channel> <triple>` succeed. `rustup run <channel> cargo|rustc --version` returns the pinned version. Every invocation and its `RUSTUP_TOOLCHAIN` value is logged.
- Rustup-prefix `cargo --version` and `rustc --version` log that the proxy was selected and return the pinned versions only when `RUSTUP_TOOLCHAIN=1.96.1`. `TEST_PROXY_VERSION_MISMATCH=1` makes the direct proxy output disagree with `rustup run`.
- `npm install` logs its `RUSTUP_TOOLCHAIN` value and succeeds. `npm run tauri -- build ...` logs every argument and the toolchain environment, extracts the target triple, waits long enough to be newer than any marker, and creates artifacts according to `TEST_ARTIFACT_MODE=all|app|none` (default `all`). The full mode creates `src-tauri/target/<triple>/release/bundle/macos/RapidRAW.app` plus `bundle/dmg/RapidRAW_1.5.9_<arch>.dmg` in the fixture.

Run fixture commands with explicit test variables and a controlled path:

```bash
run_fixture() {
  set +e
  command_output="$(
    TEST_COMMAND_LOG="$command_log" \
    TEST_RUSTUP_PREFIX="$rustup_prefix" \
    TEST_FIXTURE_ROOT="$fixture_root" \
    TEST_UNAME_MACHINE="${TEST_UNAME_MACHINE:-arm64}" \
    TEST_PROC_TRANSLATED="${TEST_PROC_TRANSLATED:-0}" \
    TEST_SYSCTL_STATUS="${TEST_SYSCTL_STATUS:-0}" \
    TEST_PROXY_VERSION_MISMATCH="${TEST_PROXY_VERSION_MISMATCH:-0}" \
    TEST_ARTIFACT_MODE="${TEST_ARTIFACT_MODE:-all}" \
    RUSTUP_TOOLCHAIN="${TEST_INHERITED_RUSTUP_TOOLCHAIN:-stable}" \
    PATH="$stub_bin:/usr/bin:/bin" \
      "$fixture_root/build-macos-release.sh" "$@" 2>&1
  )"
  command_status=$?
  set -e
}
```

- [ ] **Step 2: Write failing build-orchestration tests**

Add assertions for:

```bash
test_explicit_arm64_build() {
  setup_fixture
  run_fixture --target arm64
  assert_status 0
  assert_log_contains "rustup toolchain install 1.96.1 --no-self-update --profile minimal"
  assert_log_contains "rustup target add --toolchain 1.96.1 aarch64-apple-darwin"
  assert_log_contains "proxy cargo --version"
  assert_log_contains "proxy rustc --version"
  assert_log_excludes "standalone cargo"
  assert_log_excludes "standalone rustc"
  assert_log_contains "npm install"
  assert_log_contains "npm env RUSTUP_TOOLCHAIN=1.96.1"
  assert_log_contains "npm run tauri -- build --verbose --target aarch64-apple-darwin --bundles app,dmg --no-sign"
  assert_contains "$command_output" "Architecture: arm64"
  assert_contains "$command_output" "Target: aarch64-apple-darwin"
}

test_explicit_x86_64_build() {
  setup_fixture
  run_fixture --target x86_64
  assert_status 0
  assert_log_contains "--target x86_64-apple-darwin"
}

test_rosetta_defaults_to_arm64() {
  setup_fixture
  TEST_UNAME_MACHINE=x86_64 TEST_PROC_TRANSLATED=1 run_fixture
  assert_status 0
  assert_log_contains "--target aarch64-apple-darwin"
}

test_native_intel_defaults_to_x86_64() {
  setup_fixture
  TEST_UNAME_MACHINE=x86_64 TEST_PROC_TRANSLATED=0 run_fixture
  assert_status 0
  assert_log_contains "--target x86_64-apple-darwin"
}

test_missing_rosetta_sysctl_defaults_to_x86_64() {
  setup_fixture
  TEST_UNAME_MACHINE=x86_64 TEST_SYSCTL_STATUS=1 run_fixture
  assert_status 0
  assert_log_contains "--target x86_64-apple-darwin"
}

test_inherited_toolchain_cannot_override_pin() {
  setup_fixture
  TEST_INHERITED_RUSTUP_TOOLCHAIN=stable run_fixture --target arm64
  assert_status 0
  assert_log_contains "npm env RUSTUP_TOOLCHAIN=1.96.1"
  assert_log_excludes "npm env RUSTUP_TOOLCHAIN=stable"
}

test_proxy_version_mismatch_fails_before_npm() {
  setup_fixture
  TEST_PROXY_VERSION_MISMATCH=1 run_fixture --target arm64
  assert_status 1
  assert_contains "$command_output" "Cargo version does not match pinned toolchain"
  assert_log_excludes "npm install"
}
```

Also add focused failure cases proving a non-Darwin host, missing npm, missing Homebrew, and missing Homebrew rustup proxy fail before `npm install`. Re-run unknown, missing-value, unsupported, duplicate, and positional-argument cases against the fixture and assert that their command logs remain empty, proving validation occurs before even host/prerequisite checks. Keep each failure deterministic by changing only the corresponding stub behavior.

- [ ] **Step 3: Run the orchestration tests and verify RED**

Run:

```bash
bash tests/build-macos-release.test.sh
```

Expected: the CLI cases remain green, while the first fake-build case fails because the script does not yet perform toolchain setup or invoke npm/Tauri.

- [ ] **Step 4: Implement host, target, and toolchain preparation**

After parsing:

1. Resolve the absolute repository root from `BASH_SOURCE[0]`, set `tauri_dir="$repo_root/src-tauri"`, and `cd "$repo_root"`.
2. Require `uname -s` to equal `Darwin`; require `npm` and `brew` with actionable errors.
3. If no explicit target was given, read `uname -m`. When it is `x86_64`, capture `sysctl -in sysctl.proc_translated 2>/dev/null || true`; only value `1` means native `arm64`. An unavailable key, empty output, or any other value means native Intel. Otherwise accept only `arm64` or `x86_64`.
4. Map `arm64` to `aarch64-apple-darwin` and `x86_64` to `x86_64-apple-darwin`.
5. Resolve `rustup_prefix="$(brew --prefix rustup)"`, require executable proxies under `$rustup_prefix/bin`, and export `PATH="$rustup_prefix/bin:$PATH"` unconditionally.
6. Assert that `command -v rustup`, `cargo`, and `rustc` resolve to those exact proxy paths.
7. Extract exactly one nonempty `channel = "..."` value from `src-tauri/rust-toolchain.toml`; fail on a missing or ambiguous channel. Set `RUSTUP_TOOLCHAIN` to this derived value for the script and all child commands, deliberately replacing any inherited value or directory override.
8. Run `rustup toolchain install "$toolchain" --no-self-update --profile minimal` and `rustup target add --toolchain "$toolchain" "$target_triple"` explicitly.
9. From `src-tauri`, capture `cargo --version` and `rustc --version`, compare both with `rustup run "$toolchain" <tool> --version`, and fail before npm on a mismatch. Print the verified versions.

Use a general failure helper for runtime errors:

```bash
die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}
```

Do not hard-code `1.96.1` in the script. The TOML `channel` field remains authoritative, and the derived `RUSTUP_TOOLCHAIN` ensures npm/Tauri cannot inherit a conflicting selection.

- [ ] **Step 5: Invoke the local Tauri CLI without signing**

From the repository root run exactly:

```bash
npm install
npm run tauri -- build \
  --verbose \
  --target "$target_triple" \
  --bundles app,dmg \
  --no-sign
```

For this task, verify that `bundle/macos/RapidRAW.app` is a directory and at least one `bundle/dmg/*.dmg` is a file, then print the architecture, target triple, app path, and every matching DMG path. Task 3 will make those checks freshness-aware.

- [ ] **Step 6: Verify orchestration is GREEN**

Run:

```bash
bash -n build-macos-release.sh
bash -n tests/build-macos-release.test.sh
bash tests/build-macos-release.test.sh
```

Expected: every CLI, prerequisite, explicit-target, native-Intel, and Rosetta case passes. The command log contains rustup proxies, the explicit target, `--bundles app,dmg`, and `--no-sign`; it contains no standalone Cargo/Rustc invocation.

- [ ] **Step 7: Commit the build orchestration**

```bash
git add build-macos-release.sh tests/build-macos-release.test.sh
git commit -m "feat(build): package unsigned macOS releases"
```

### Task 3: Reject Stale Bundle Artifacts

**Files:**

- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/tests/build-macos-release.test.sh`
- Modify: `/Users/laynewang/Documents/RustProjects/RapidRAW/build-macos-release.sh`

- [ ] **Step 1: Add failing freshness tests**

Use the fake npm build stub's `TEST_ARTIFACT_MODE=none` setting to skip artifact creation. Add:

```bash
test_stale_artifacts_do_not_satisfy_build() {
  setup_fixture
  create_fixture_artifacts aarch64-apple-darwin
  touch -t 202001010000 \
    "$fixture_root/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/RapidRAW.app" \
    "$fixture_root/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/"*.dmg

  TEST_ARTIFACT_MODE=none run_fixture --target arm64

  assert_status 1
  assert_contains "$command_output" "fresh RapidRAW.app was not produced"
}
```

Add a second case with `TEST_ARTIFACT_MODE=app` and verify the script fails with `no fresh .dmg was produced`. This distinguishes the two required artifact checks.

- [ ] **Step 2: Run freshness tests and verify RED**

Run:

```bash
bash tests/build-macos-release.test.sh
```

Expected: the stale-artifact case fails because the current script accepts files left by an earlier build.

- [ ] **Step 3: Add marker-based artifact validation**

Immediately after `npm install` and immediately before the Tauri command, create a unique marker:

```bash
build_marker="$(mktemp "${TMPDIR:-/tmp}/rapidraw-macos-build.XXXXXX")"
trap 'rm -f "$build_marker"' EXIT
```

After Tauri returns successfully:

- Require the exact directory `src-tauri/target/<triple>/release/bundle/macos/RapidRAW.app` and require it to be newer than `$build_marker` with Bash `-nt`.
- Collect only regular `*.dmg` files beneath the target-specific `bundle/dmg` directory that satisfy `find ... -newer "$build_marker" -print0`.
- Use a Bash 3.2-compatible process substitution exactly shaped as `while IFS= read -r -d '' path; do ...; done < <(find ... -newer "$build_marker" -print0)`. Do not pipe into the loop: a pipeline subshell would discard the collected array.
- Fail when no fresh DMG is collected.
- Print only the fresh app and DMG paths; never report stale matches.

- [ ] **Step 4: Verify all shell behavior is GREEN**

Run:

```bash
bash -n build-macos-release.sh
bash -n tests/build-macos-release.test.sh
bash tests/build-macos-release.test.sh
git diff --check
```

Expected: every harness case passes, including stale app, fresh-app-only, Rosetta, proxy precedence, and explicit unsigned bundle arguments. Whitespace validation reports nothing.

- [ ] **Step 5: Commit freshness enforcement**

```bash
git add build-macos-release.sh tests/build-macos-release.test.sh
git commit -m "test(build): reject stale macOS bundles"
```

### Task 4: Review And Run A Real Native Release Build

**Files:**

- Verify: `/Users/laynewang/Documents/RustProjects/RapidRAW/build-macos-release.sh`
- Verify: `/Users/laynewang/Documents/RustProjects/RapidRAW/tests/build-macos-release.test.sh`

- [ ] **Step 1: Request implementation review**

Use @requesting-code-review. Ask the reviewer to check Bash 3.2 compatibility, argument failures before side effects, Rosetta detection, exact rustup proxy/toolchain selection, explicit `--no-sign`, marker lifetime, fresh artifact collection, and protected remote/branch constraints. Fix and re-review every Critical, Important, or Minor finding before continuing.

- [ ] **Step 2: Run the complete fast verification suite**

Run:

```bash
bash -n build-macos-release.sh
bash -n tests/build-macos-release.test.sh
bash tests/build-macos-release.test.sh
./build-macos-release.sh --help
git diff --check
```

Expected: syntax checks and all harness tests pass; help exits zero; whitespace validation reports nothing.

- [ ] **Step 3: Run the actual native release build**

Run from a directory other than the repository root to verify location independence:

```bash
(
  cd /Users/laynewang/Documents/RustProjects
  /Users/laynewang/Documents/RustProjects/RapidRAW/build-macos-release.sh
)
```

Expected on this Apple Silicon Mac: the script verifies Cargo/Rustc 1.96.1, selects `aarch64-apple-darwin`, completes the Tauri release build, and prints fresh absolute paths for `RapidRAW.app` and at least one `.dmg` under `src-tauri/target/aarch64-apple-darwin/release/bundle/`.

- [ ] **Step 4: Inspect the real artifacts and repository state**

Run:

```bash
cd /Users/laynewang/Documents/RustProjects/RapidRAW
test -d src-tauri/target/aarch64-apple-darwin/release/bundle/macos/RapidRAW.app
find src-tauri/target/aarch64-apple-darwin/release/bundle/dmg -type f -name '*.dmg' -print
test "$(git branch --show-current)" = "cl/vegdog/fix-raf-reading"
test "$(git remote get-url --push origin)" = "https://github.com/lincvic/RapidRAW"
git status --short
```

Expected: the app and DMG exist; generated artifacts are ignored; both hard assertions pass; no command targets `CyberTimon`.

- [ ] **Step 5: Commit any review-driven fixes and require a clean worktree**

If review changed either shell file, repeat the fast suite and commit only those reviewed changes:

```bash
git add build-macos-release.sh tests/build-macos-release.test.sh
git diff --cached --quiet || git commit -m "fix(build): address macOS script review"
test -z "$(git status --porcelain)"
```

Expected: all implementation changes are committed and the worktree is clean. Generated bundles remain ignored.

- [ ] **Step 6: Run final verification and push only the fork feature branch**

Use @verification-before-completion, then run:

```bash
git diff --check
git status --short --branch
test "$(git branch --show-current)" = "cl/vegdog/fix-raf-reading"
test "$(git remote get-url --push origin)" = "https://github.com/lincvic/RapidRAW"
test -z "$(git status --porcelain)"
git push origin cl/vegdog/fix-raf-reading
```

Expected: only planned commits are ahead before the push, the push updates `lincvic/RapidRAW`'s feature branch, and neither `main` nor `fork-dev` changes. Do not create any pull request.
