# macOS Release Build Script Design

## Context

RapidRAW already produces macOS release artifacts through Tauri in GitHub Actions, but the repository has no local build script. The CI matrix builds Apple Silicon and Intel separately with explicit Rust target triples. Tauri owns frontend compilation and macOS packaging, and the repository does not configure Apple signing or notarization.

The local script should expose that existing build path without introducing a second packaging system.

## Goals

- Build an unsigned release-mode `RapidRAW.app` and `.dmg` on macOS, even when signing credentials are present in the caller's environment.
- Default to the Mac's native hardware architecture, including when the shell is running under Rosetta.
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

With no target option, the script detects the native hardware architecture. It first reads `uname -m`; when that reports `x86_64`, it also checks `sysctl -in sysctl.proc_translated`. A value of `1` means the process is translated by Rosetta on Apple Silicon, so the native architecture is `arm64`. Otherwise, architectures map as follows:

| macOS architecture | Rust target triple     |
| ------------------ | ---------------------- |
| `arm64`            | `aarch64-apple-darwin` |
| `x86_64`           | `x86_64-apple-darwin`  |

`--target arm64` and `--target x86_64` select those same triples. Missing option values, unsupported architectures, extra positional arguments, and unknown options exit nonzero and print usage.

## Build Flow

The script uses `/usr/bin/env bash` with `set -euo pipefail` and resolves the repository root from its own file location before running commands.

It performs these steps in order:

1. Require `uname -s` to report `Darwin`.
2. Require `npm` and Homebrew. Resolve Homebrew's `rustup` prefix and unconditionally prepend its `bin` directory to `PATH`, ensuring the rustup `cargo` and `rustc` proxies take precedence over a standalone Homebrew Rust installation.
3. Resolve the selected Rust target triple.
4. Read the channel from `src-tauri/rust-toolchain.toml`, explicitly select and install that toolchain, and add the selected target to it. Override any inherited `RUSTUP_TOOLCHAIN` for child commands with the repository-pinned channel so neither caller environment nor a rustup directory override can supersede the pin. Verify that the `cargo` and `rustc` commands which the build will use are rustup proxies running that toolchain's versions.
5. Run `npm install`, matching the repository's build workflow.
6. Immediately before compilation, create a temporary timestamp marker.
7. Run `npm run tauri -- build --verbose --target <target-triple> --bundles app,dmg --no-sign`. The explicit `--no-sign` prevents inherited Apple credentials from enabling signing or notarization.
8. Verify that the expected `RapidRAW.app` is newer than the marker and that at least one `.dmg` newer than the marker exists in the target-specific release bundle directory.
9. Print the architecture, target triple, and absolute paths of only those fresh artifacts.

The expected output root is:

```text
src-tauri/target/<target-triple>/release/bundle/
```

The application should be under `bundle/macos/`, and the disk image should be under `bundle/dmg/`.

## Toolchain Behavior

The script must put `$(brew --prefix rustup)/bin` at the front of `PATH` even when `rustup` is already discoverable. It reads the toolchain channel from `src-tauri/rust-toolchain.toml`, explicitly installs that toolchain and its selected compilation target, and exports the derived channel as `RUSTUP_TOOLCHAIN` only to the script and its child processes. Before starting npm or Tauri, it checks the resolved `cargo` and `rustc` executables and compares their versions with `rustup run <pinned-channel>`. This ensures Tauri and Cargo honor the repository's Rust 1.96.1 pin instead of a standalone Homebrew Rust installation, an inherited toolchain selection, or a rustup directory override. The toolchain version is not duplicated in the script; `src-tauri/rust-toolchain.toml` remains authoritative.

Cross-architecture builds remain one target per invocation. The script installs the requested Rust standard-library target but does not install Rosetta, Xcode, or additional linker components automatically. If the local Xcode toolchain cannot produce the requested architecture, the Tauri/Cargo error is preserved.

## Error Handling

Each preflight failure prints a concise message to standard error and exits nonzero. The script does not suppress output from npm, rustup, Cargo, or Tauri. A successful command is not reported unless both required bundle types are present.

Because the output is intentionally unsigned, the script does not invent, require, or clear `APPLE_*` environment variables. Any environment inherited from the caller remains untouched, while Tauri's explicit `--no-sign` option makes those variables irrelevant to the build.

The timestamp marker is removed on exit. Pre-existing `.app` or `.dmg` files cannot satisfy success checks and are not included in the reported artifact list.

## Verification

Verification covers:

- `bash -n build-macos-release.sh`.
- `--help` exits zero and documents both supported target values.
- Unknown options, missing target values, and unsupported targets exit nonzero before dependency installation or compilation.
- Native target detection selects `arm64` when invoked by an `x86_64` process translated by Rosetta.
- Native Intel detection remains `x86_64` when the Rosetta sysctl key is unavailable.
- Homebrew's rustup proxies take precedence, inherited toolchain overrides cannot supersede the repository pin, and the selected Cargo/Rustc versions match the toolchain pinned under `src-tauri`.
- The Tauri invocation contains explicit `--bundles app,dmg` and `--no-sign` arguments.
- A native invocation completes successfully on macOS.
- The resulting `.app` and `.dmg` exist under the selected target's release bundle directory and are newer than the pre-build marker.
- Pre-existing bundle files alone cannot make a failed or incomplete build appear successful.
- `git diff --check` passes and generated build artifacts remain ignored.
