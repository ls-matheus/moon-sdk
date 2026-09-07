#!/bin/bash
set -euo pipefail
export LC_ALL=C
repo="$(cd "$(dirname "$0")/.." && pwd)"
output="${1:-$repo/Moon-SDK-Installer.pkg}"
assets="$repo/macos-resources"
repository="${GITHUB_REPOSITORY:-ls-matheus/moon-sdk}"
resource_tag="${RESOURCE_TAG:-macos-resources-local-$(date +%Y%m%d%H%M%S)}"
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
[[ "$resource_tag" =~ ^[A-Za-z0-9_.-]+$ ]]
mkdir -p "$assets"
work="$(mktemp -d)"
export npm_config_cache="$work/npm-cache"
trap 'rm -rf "$work"' EXIT
cd "$repo"
npm ci --ignore-scripts
npm test
npm run build
mkdir "$work/scripts"
cp installer/pkg-scripts/postinstall installer/pkg-scripts/install-runtime.sh "$work/scripts/"
# Materialize the SDK from the lockfile instead of resolving semver on the user's Mac.
sdk="$work/payload/lib/node_modules/@moon/sdk"
mkdir -p "$sdk"
cp package.json package-lock.json README.md DATABASES.md SYNC.md "$sdk/"
cp -R bin dist "$sdk/"
npm ci --prefix "$sdk" --omit=dev --ignore-scripts --no-audit --no-fund
npm install --global --prefix "$work/payload" --ignore-scripts --no-audit --no-fund @base44/sdk@0.8.48
if find "$work/payload" -name '*.node' -print | /usr/bin/grep -q .; then
  echo "Dependência nativa encontrada: gerar payloads separados por arquitetura." >&2
  exit 1
fi
tar -czf "$assets/moon-sdk.tgz" -C "$work/payload" .
(cd "$assets" && shasum -a 256 moon-sdk.tgz) > "$work/scripts/resources.sha256"
# Publish runtimes separately; only hashes and the immutable release URL go in the pkg.
curl -fLsS --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$work/SHASUMS256.txt"
for architecture in arm64 x64; do
  filename="$(awk -v arch="$architecture" '$2 ~ ("^node-v[0-9.]+-darwin-" arch "\\.tar\\.gz$") {print $2}' "$work/SHASUMS256.txt")"
  [[ "$filename" =~ ^node-v[0-9.]+-darwin-(arm64|x64)\.tar\.gz$ ]]
  version="${filename#node-}"
  version="${version%%-darwin-*}"
  curl -fLsS --retry 3 "https://nodejs.org/dist/$version/$filename" -o "$assets/$filename"
  awk -v file="$filename" '$2 == file' "$work/SHASUMS256.txt" > "$work/checksum.txt"
  (cd "$assets" && shasum -a 256 -c "$work/checksum.txt")
  cat "$work/checksum.txt" >> "$work/scripts/resources.sha256"
done
printf '%s\n' "https://github.com/$repository/releases/download/$resource_tag" > "$work/scripts/resources-url.txt"
cp "$work/scripts/resources.sha256" "$assets/resources.sha256"
chmod 755 "$work/scripts/postinstall" "$work/scripts/install-runtime.sh"
pkgbuild --nopayload --scripts "$work/scripts" --identifier com.moon.sdk.installer \
  --version "1.3.${GITHUB_RUN_NUMBER:-0}" "$output"
