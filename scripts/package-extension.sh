#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: scripts/package-extension.sh SIGNING_KEY_PEM OUTPUT_CRX" >&2
  exit 2
fi

signing_key="$1"
output_crx="$2"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -s "$signing_key" ]]; then
  echo "Chrome extension signing key not found: $signing_key" >&2
  exit 1
fi

if [[ -n "${CHROME_BIN:-}" ]]; then
  chrome_bin="$CHROME_BIN"
elif command -v google-chrome-stable >/dev/null 2>&1; then
  chrome_bin="$(command -v google-chrome-stable)"
elif [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  chrome_bin="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  echo "Google Chrome was not found; set CHROME_BIN explicitly." >&2
  exit 1
fi

package_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$package_dir"
}
trap cleanup EXIT

cp -R "$repo_root/extension" "$package_dir/extension"
"$chrome_bin" \
  --pack-extension="$package_dir/extension" \
  --pack-extension-key="$signing_key"

mkdir -p "$(dirname "$output_crx")"
install -m 0644 "$package_dir/extension.crx" "$output_crx"
shasum -a 256 "$output_crx"
