#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: build-macos-release.sh [--target arm64|x86_64]

Build unsigned RapidRAW.app and .dmg release artifacts for macOS.

Options:
  --target arm64|x86_64  Select the target architecture.
  -h, --help             Show this help message.
EOF
}

usage_error() {
  printf 'Error: %s\n' "$1" >&2
  usage >&2
  exit 2
}

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

requested_arch=''
target_seen=0
help_requested=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -h|--help)
      help_requested=1
      shift
      ;;
    --target)
      if [[ "$target_seen" -eq 1 ]]; then
        usage_error '--target may only be specified once'
      fi
      target_seen=1

      if [[ "$#" -lt 2 ]] || [[ "$2" == -* ]]; then
        usage_error '--target requires a value'
      fi

      case "$2" in
        arm64|x86_64)
          requested_arch="$2"
          ;;
        *)
          usage_error "unsupported target: $2"
          ;;
      esac
      shift 2
      ;;
    -*)
      usage_error "unknown option: $1"
      ;;
    *)
      usage_error "unexpected argument: $1"
      ;;
  esac
done

if [[ "$help_requested" -eq 1 ]]; then
  usage
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$script_dir"
tauri_dir="$repo_root/src-tauri"
toolchain_file="$tauri_dir/rust-toolchain.toml"

cd "$repo_root"

host_system="$(uname -s)"
if [[ "$host_system" != 'Darwin' ]]; then
  die "macOS is required to build macOS release artifacts (detected $host_system)"
fi

if ! command -v npm >/dev/null 2>&1; then
  die 'npm is required; install Node.js and npm before building'
fi

if ! command -v brew >/dev/null 2>&1; then
  die 'Homebrew is required; install Homebrew and the rustup formula before building'
fi

if [[ -n "$requested_arch" ]]; then
  architecture="$requested_arch"
else
  host_machine="$(uname -m)"
  case "$host_machine" in
    arm64)
      native_arch='arm64'
      ;;
    x86_64)
      translated="$(sysctl -in sysctl.proc_translated 2>/dev/null || true)"
      if [[ "$translated" == '1' ]]; then
        native_arch='arm64'
      else
        native_arch='x86_64'
      fi
      ;;
    *)
      die "unsupported macOS host architecture: $host_machine"
      ;;
  esac
  architecture="$native_arch"
fi

case "$architecture" in
  arm64)
    target_triple='aarch64-apple-darwin'
    ;;
  x86_64)
    target_triple='x86_64-apple-darwin'
    ;;
esac

rustup_prefix="$(brew --prefix rustup)"
if [[ -z "$rustup_prefix" ]]; then
  die 'Homebrew returned an empty prefix for the rustup formula'
fi
rustup_bin="$rustup_prefix/bin"

for proxy_name in rustup cargo rustc; do
  proxy_path="$rustup_bin/$proxy_name"
  if [[ ! -x "$proxy_path" ]]; then
    die "Homebrew rustup proxy is missing or not executable: $proxy_path"
  fi
done

export PATH="$rustup_bin:$PATH"

for proxy_name in rustup cargo rustc; do
  proxy_path="$rustup_bin/$proxy_name"
  resolved_proxy="$(command -v "$proxy_name" || true)"
  if [[ "$resolved_proxy" != "$proxy_path" ]]; then
    die "Homebrew rustup proxy was not selected for $proxy_name: expected $proxy_path, got ${resolved_proxy:-not found}"
  fi
done

if ! toolchain="$(
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*\[/ {
      in_toolchain = 0
      if ($0 ~ /^[[:space:]]*\[toolchain\][[:space:]]*(#.*)?$/) {
        in_toolchain = 1
        toolchain_sections++
      }
      next
    }
    in_toolchain && /^[[:space:]]*channel[[:space:]]*=/ {
      declarations++
      if ($0 ~ /^[[:space:]]*channel[[:space:]]*=[[:space:]]*"[^"]+"[[:space:]]*(#.*)?$/) {
        value = $0
        sub(/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"/, "", value)
        sub(/"[[:space:]]*(#.*)?$/, "", value)
        valid++
        selected = value
      }
    }
    END {
      if (toolchain_sections == 1 && declarations == 1 && valid == 1) {
        print selected
      } else {
        exit 1
      }
    }
  ' "$toolchain_file"
)"; then
  die "could not determine the pinned Rust toolchain; pin exactly one nonempty quoted channel in [toolchain] of $toolchain_file"
fi

export RUSTUP_TOOLCHAIN="$toolchain"

rustup toolchain install "$toolchain" --no-self-update --profile minimal
rustup target add --toolchain "$toolchain" "$target_triple"

cd "$tauri_dir"
cargo_version="$(cargo --version)"
rustup_cargo_version="$(rustup run "$toolchain" cargo --version)"
if [[ "$cargo_version" != "$rustup_cargo_version" ]]; then
  die "Cargo version mismatch: rustup proxy returned '$cargo_version', but rustup run returned '$rustup_cargo_version'"
fi

rustc_version="$(rustc --version)"
rustup_rustc_version="$(rustup run "$toolchain" rustc --version)"
if [[ "$rustc_version" != "$rustup_rustc_version" ]]; then
  die "Rustc version mismatch: rustup proxy returned '$rustc_version', but rustup run returned '$rustup_rustc_version'"
fi

cd "$repo_root"
npm install
build_marker="$(mktemp "${TMPDIR:-/tmp}/rapidraw-macos-build.XXXXXX")"
trap 'rm -f "$build_marker"' EXIT
npm run tauri -- build --verbose --target "$target_triple" --bundles app,dmg --no-sign

bundle_dir="$tauri_dir/target/$target_triple/release/bundle"
app_path="$bundle_dir/macos/RapidRAW.app"
if [[ ! -d "$app_path" ]] || [[ ! "$app_path" -nt "$build_marker" ]]; then
  die "fresh RapidRAW.app was not produced at $app_path"
fi

dmg_paths=()
if [[ -d "$bundle_dir/dmg" ]]; then
  while IFS= read -r -d '' candidate; do
    dmg_paths[${#dmg_paths[@]}]="$candidate"
  done < <(find "$bundle_dir/dmg" -type f -name '*.dmg' -newer "$build_marker" -print0)
fi

if [[ "${#dmg_paths[@]}" -eq 0 ]]; then
  die "no fresh .dmg was produced in $bundle_dir/dmg"
fi

printf 'Architecture: %s\n' "$architecture"
printf 'Target: %s\n' "$target_triple"
printf 'Cargo: %s\n' "$cargo_version"
printf 'Rustc: %s\n' "$rustc_version"
printf 'App: %s\n' "$app_path"
for dmg_path in "${dmg_paths[@]}"; do
  printf 'DMG: %s\n' "$dmg_path"
done
