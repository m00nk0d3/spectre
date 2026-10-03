#!/usr/bin/env bash
set -euo pipefail

repository="${SPECTRE_GITHUB_REPOSITORY:-m00nk0d3/spectre}"
requested_version="${SPECTRE_VERSION:-latest}"
install_runtime=true

usage() {
  cat <<'EOF'
Install Spectre for the current Linux user.

Usage: install-spectre.sh [options]

Options:
  --version VERSION  Install a release version such as 1.0.0 or v1.0.0.
  --no-runtime       Skip the managed Python/Faster Whisper runtime.
  --help             Show this help.

Environment:
  SPECTRE_GITHUB_REPOSITORY  GitHub owner/repository (default: m00nk0d3/spectre)
  SPECTRE_RELEASE_BASE_URL   Exact release asset base URL, useful for mirrors.
  SPECTRE_VERSION            Version or "latest".
  XDG_BIN_HOME               Executable directory (default: ~/.local/bin)
  XDG_DATA_HOME              Data directory (default: ~/.local/share)
EOF
}

while (($# > 0)); do
  case "$1" in
    --version)
      if (($# < 2)); then
        echo "--version requires a value" >&2
        exit 2
      fi
      requested_version="$2"
      shift 2
      ;;
    --no-runtime)
      install_runtime=false
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

for command in curl sha256sum install mktemp; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "Spectre release assets currently support Linux x86_64 only." >&2
  exit 1
fi

if [[ "$requested_version" == "latest" ]]; then
  latest_url="$(
    curl \
      --fail \
      --location \
      --silent \
      --show-error \
      --output /dev/null \
      --write-out '%{url_effective}' \
      "https://github.com/${repository}/releases/latest"
  )"
  tag="${latest_url##*/}"
else
  tag="$requested_version"
  [[ "$tag" == v* ]] || tag="v${tag}"
fi

if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Could not resolve a valid Spectre release tag: $tag" >&2
  exit 1
fi

version="${tag#v}"
release_base_url="${SPECTRE_RELEASE_BASE_URL:-https://github.com/${repository}/releases/download/${tag}}"
app_asset="spectre-${version}-x86_64.AppImage"
requirements_asset="spectre-python-requirements-${version}.txt"
uninstaller_asset="uninstall-spectre.sh"

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
bin_home="${XDG_BIN_HOME:-$HOME/.local/bin}"
applications_home="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
app_root="$data_home/spectre/app"
app_path="$app_root/spectre-${version}.AppImage"
launcher_path="$bin_home/spectre"
desktop_path="$applications_home/spectre.desktop"
uninstaller_path="$bin_home/spectre-uninstall"
runtime_root="${SPECTRE_PYTHON_RUNTIME:-$data_home/spectre/python}"
python_path="$runtime_root/bin/python"

temporary_directory="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

download() {
  local asset="$1"
  curl \
    --fail \
    --location \
    --silent \
    --show-error \
    --output "$temporary_directory/$asset" \
    "$release_base_url/$asset"
}

download SHA256SUMS
download "$app_asset"
download "$uninstaller_asset"
if "$install_runtime"; then
  download "$requirements_asset"
fi

(
  cd "$temporary_directory"
  grep -F "  $app_asset" SHA256SUMS | sha256sum --check -
  grep -F "  $uninstaller_asset" SHA256SUMS | sha256sum --check -
  if "$install_runtime"; then
    grep -F "  $requirements_asset" SHA256SUMS | sha256sum --check -
  fi
)

mkdir -p "$app_root" "$bin_home" "$applications_home"
previous_app="$(readlink -f "$launcher_path" 2>/dev/null || true)"
install -m 0755 "$temporary_directory/$app_asset" "$app_path"
install -m 0755 "$temporary_directory/$uninstaller_asset" "$uninstaller_path"
ln -sfn "$app_path" "$launcher_path"
if [[
  -n "$previous_app"
  && "$previous_app" != "$app_path"
  && "$previous_app" == "$app_root/"*
]]; then
  rm -f -- "$previous_app"
fi

cat > "$desktop_path" <<EOF
[Desktop Entry]
Type=Application
Name=Spectre
Comment=Local English voice assistant
Exec="$launcher_path"
Terminal=false
Categories=AudioVideo;Utility;
StartupWMClass=spectre
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$applications_home" >/dev/null 2>&1 || true
fi

if "$install_runtime"; then
  uv_path="$(command -v uv || true)"
  if [[ -z "$uv_path" && -x "$bin_home/uv" ]]; then
    uv_path="$bin_home/uv"
  fi
  if [[ -z "$uv_path" ]]; then
    uv_installer="$temporary_directory/install-uv.sh"
    curl \
      --fail \
      --location \
      --silent \
      --show-error \
      --output "$uv_installer" \
      https://astral.sh/uv/install.sh
    UV_UNMANAGED_INSTALL="$bin_home" sh "$uv_installer"
    uv_path="$bin_home/uv"
  fi

  if [[ ! -x "$python_path" ]]; then
    "$uv_path" venv --python 3.12 "$runtime_root"
  fi
  "$uv_path" pip install \
    --python "$python_path" \
    --requirements "$temporary_directory/$requirements_asset"

  "$python_path" - <<'PY'
from kokoro import KPipeline

pipeline = KPipeline(lang_code="a")
next(iter(pipeline(
    "Everything is ready.",
    voice="am_michael",
    speed=1.1,
)))
PY

  whisper_cache="${SPECTRE_WHISPER_RUNTIME:-$data_home/spectre/whisper}/faster-whisper"
  "$python_path" - "$whisper_cache" <<'PY'
import sys
from faster_whisper.utils import download_model

download_model(
    "dropbox-dash/faster-whisper-large-v3-turbo",
    cache_dir=sys.argv[1],
)
PY
fi

echo "[SPECTRE] Installed version $version"
echo "[SPECTRE] Launch with: spectre"
echo "[SPECTRE] Uninstall with: spectre-uninstall"
if ! "$install_runtime"; then
  echo "[SPECTRE] Runtime setup was skipped; configure SPECTRE_PYTHON_RUNTIME before launch."
fi
echo "[SPECTRE] LM Studio must be running locally on port 1234."
