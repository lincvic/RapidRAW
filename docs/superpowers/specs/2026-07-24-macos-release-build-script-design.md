# macOS Release Build Script Design

## Context

RapidRAW already produces macOS release artifacts through Tauri in GitHub Actions, but the repository has no local build script. The CI matrix builds Apple Silicon and Intel separately with explicit Rust target triples. Tauri owns frontend compilation and macOS packaging, and the repository does not configure Apple signing or notarization.

The local script should expose that existing build path without introducing a second packaging system.

## Goals

- Build an unsigned release-mode `RapidRAW.app` and `.dmg` on macOS.
- Default to the current Mac architecture.
- Allow one explicit architecture override per invocation.
- Use the repository-pinned Rust toolchain and existing Tauri configuration.
- Work when invoked from any current working directory.
- Fail early with actionable prerequisite or argument errors.
- Print the resulting artifact paths after a successful build.

## Non-Goals

- Apple code signing, notarization, stapling, or credential management.
- A universal binary or automatic two-architecture build.
- Uploading artifacts or creating a GitHub release.
- Copying artifacts outside Tauri's standard target directory.
- Reimplementing Tauri's bundling logic.

## Command Interface

Add an executable root-level script named `build-macos-release.sh`.

Supported invocations:

```bash
./build-macos-release.sh
./build-macos-release.sh --target arm64
./build-macos-release.sh --target x86_64
./build-macos-release.sh --help
```

With no target option, the script maps `uname -m` as follows:

| macOS architecture | Rust target triple     |
| ------------------ | ---------------------- |
| `arm64`            | `aarch64-apple-darwin` |
| `x86_64`           | `x86_64-apple-darwin`  |

`--target arm64` and `--target x86_64` select those same triples. Missing option values, unsupported architectures, extra positional arguments, and unknown options exit nonzero and print usage.

## Build Flow

The script uses `/usr/bin/env bash` with `set -euo pipefail` and resolves the repository root from its own file location before running commands.

It performs these steps in order:

1. Require `uname -s` to report `Darwin`.
2. Require `npm` and locate `rustup`. If rustup is not already on `PATH`, check Homebrew's `rustup` prefix and prepend its `bin` directory.
3. Resolve the selected Rust target triple.
4. From the repository root, let rustup read `src-tauri/rust-toolchain.toml`, verify that the pinned toolchain is available, and add the selected target to that toolchain.
5. Run `npm install`, matching the repository's build workflow.
6. Run the Tauri release build with verbose output, the selected target, and explicit `app` and `dmg` bundles.
7. Verify that Tauri produced at least one `.app` and one `.dmg` in the target-specific release bundle directory.
8. Print the architecture, target triple, and absolute artifact paths.

The expected output root is:

```text
src-tauri/target/<target-triple>/release/bundle/
```

The application should be under `bundle/macos/`, and the disk image should be under `bundle/dmg/`.

## Toolchain Behavior

The script must use the rustup proxy rather than an independently installed Homebrew `cargo` binary. This ensures Tauri and Cargo honor the repository's Rust 1.96.1 pin. The toolchain version is not duplicated in the script; `src-tauri/rust-toolchain.toml` remains authoritative.

Cross-architecture builds remain one target per invocation. The script installs the requested Rust standard-library target but does not install Rosetta, Xcode, or additional linker components automatically. If the local Xcode toolchain cannot produce the requested architecture, the Tauri/Cargo error is preserved.

## Error Handling

Each preflight failure prints a concise message to standard error and exits nonzero. The script does not suppress output from npm, rustup, Cargo, or Tauri. A successful command is not reported unless both required bundle types are present.

Because the output is intentionally unsigned, the script does not invent or require `APPLE_*` environment variables. Any environment inherited from the caller remains untouched.

## Verification

Verification covers:

- `bash -n build-macos-release.sh`.
- `--help` exits zero and documents both supported target values.
- Unknown options, missing target values, and unsupported targets exit nonzero before dependency installation or compilation.
- A native invocation completes successfully on macOS.
- The resulting `.app` and `.dmg` exist under the selected target's release bundle directory.
- `git diff --check` passes and generated build artifacts remain ignored.
