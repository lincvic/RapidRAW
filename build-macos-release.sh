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

exit 0
