#!/bin/bash
set -euo pipefail
export LC_ALL=C
destination="$1"
sdk_archive="$2"
case "$(uname -m)" in
  arm64) architecture=arm64 ;;
  x86_64) architecture=x64 ;;
  *) echo "Arquitetura não suportada." >&2; exit 1 ;;
esac
mkdir -p "$destination"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
download() {
  /usr/bin/curl --fail --silent --show-error --location --retry 3 --connect-timeout 30 --max-time 600 "$1" -o "$2"
}
download https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt "$work/SHASUMS256.txt"
filename="$(awk -v arch="$architecture" '$2 ~ ("^node-v[0-9.]+-darwin-" arch "\\.tar\\.gz$") {print $2}' "$work/SHASUMS256.txt")"
[[ "$filename" =~ ^node-v[0-9.]+-darwin-(arm64|x64)\.tar\.gz$ ]] || { echo "Node.js não localizado."; exit 1; }
version="${filename#node-}"
version="${version%%-darwin-*}"
download "https://nodejs.org/dist/$version/$filename" "$work/$filename"
awk -v file="$filename" '$2 == file' "$work/SHASUMS256.txt" > "$work/checksum.txt"
(cd "$work" && /usr/bin/shasum -a 256 -c checksum.txt)
tar -xzf "$work/$filename" -C "$destination" --strip-components=1
export PATH="$destination/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export npm_config_cache="$work/npm-cache"
export npm_config_registry=https://registry.npmjs.org
export npm_config_userconfig="$work/user.npmrc"
export npm_config_globalconfig="$work/global.npmrc"
echo "Instalando Moon e dependências..."
npm install --global --prefix "$destination" --no-audit --no-fund "$sdk_archive" @base44/sdk
node --version
npm --version
npm ls --global --prefix "$destination" --depth=0
moon --help
node --input-type=module -e 'await import(process.argv[1])' "$destination/lib/node_modules/@moon/sdk/dist/index.js"
test -f "$destination/lib/node_modules/@base44/sdk/package.json"
