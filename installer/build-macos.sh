#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
output="${1:-$repo/Moon-SDK-Installer.pkg}"
work="$(mktemp -d)"
export npm_config_cache="$work/npm-cache"
trap 'rm -rf "$work"' EXIT
cd "$repo"
npm ci --ignore-scripts
npm test
npm run build
npm pack --pack-destination "$work"
mkdir "$work/scripts"
cp installer/pkg-scripts/postinstall installer/pkg-scripts/install-runtime.sh "$work/scripts/"
cp "$work"/moon-sdk-*.tgz "$work/scripts/moon-sdk.tgz"
chmod 755 "$work/scripts/postinstall" "$work/scripts/install-runtime.sh"
pkgbuild --nopayload --scripts "$work/scripts" --identifier com.moon.sdk.installer \
  --version "1.1.${GITHUB_RUN_NUMBER:-0}" "$output"
