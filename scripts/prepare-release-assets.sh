#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:-$(cd "$project_root" && node -p 'require("./package.json").version')}"
release_dir="${SPECTRE_RELEASE_DIR:-$project_root/release}"
assets_dir="${SPECTRE_ASSETS_DIR:-$release_dir/assets}"

source_appimage="$release_dir/spectre-${version}.AppImage"
source_deb="$release_dir/spectre_${version}_amd64.deb"

for required_file in \
  "$source_appimage" \
  "$source_deb" \
  "$project_root/scripts/install.sh" \
  "$project_root/scripts/uninstall.sh" \
  "$project_root/src/main/python_server/requirements.txt"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Required release file not found: $required_file" >&2
    exit 1
  fi
done

mkdir -p "$assets_dir"

install -m 0755 \
  "$source_appimage" \
  "$assets_dir/spectre-${version}-x86_64.AppImage"
install -m 0644 \
  "$source_deb" \
  "$assets_dir/spectre-${version}-amd64.deb"
install -m 0755 \
  "$project_root/scripts/install.sh" \
  "$assets_dir/install-spectre.sh"
install -m 0755 \
  "$project_root/scripts/uninstall.sh" \
  "$assets_dir/uninstall-spectre.sh"
install -m 0644 \
  "$project_root/src/main/python_server/requirements.txt" \
  "$assets_dir/spectre-python-requirements-${version}.txt"

(
  cd "$assets_dir"
  sha256sum \
    "install-spectre.sh" \
    "spectre-${version}-amd64.deb" \
    "spectre-${version}-x86_64.AppImage" \
    "spectre-python-requirements-${version}.txt" \
    "uninstall-spectre.sh" \
    > SHA256SUMS
)

echo "[SPECTRE] Release assets ready at $assets_dir"
