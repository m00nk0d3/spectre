#!/usr/bin/env bash
set -euo pipefail

purge_runtime=false

usage() {
  cat <<'EOF'
Uninstall Spectre for the current Linux user.

Usage: uninstall-spectre.sh [--purge-runtime]

Options:
  --purge-runtime  Also remove managed Python and Whisper runtimes.
  --help           Show this help.

Obsidian vaults, LM Studio models, and Spectre user configuration are never
removed by this script.
EOF
}

while (($# > 0)); do
  case "$1" in
    --purge-runtime)
      purge_runtime=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
bin_home="${XDG_BIN_HOME:-$HOME/.local/bin}"
applications_home="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
spectre_root="$data_home/spectre"
app_root="$spectre_root/app"

rm -f -- "$bin_home/spectre"
rm -f -- "$bin_home/spectre-uninstall"
rm -f -- "$applications_home/spectre.desktop"

if [[ -d "$app_root" && "$app_root" == "$spectre_root/app" ]]; then
  rm -rf -- "$app_root"
fi

if "$purge_runtime"; then
  for runtime in "$spectre_root/python" "$spectre_root/whisper"; do
    if [[ -d "$runtime" && "$runtime" == "$spectre_root/"* ]]; then
      rm -rf -- "$runtime"
    fi
  done
fi

rmdir -- "$spectre_root" 2>/dev/null || true

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$applications_home" >/dev/null 2>&1 || true
fi

echo "[SPECTRE] Application removed."
if ! "$purge_runtime" && [[ -d "$spectre_root" ]]; then
  echo "[SPECTRE] Managed runtime retained at $spectre_root"
fi
