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
resources="$(cd "$(dirname "$sdk_archive")" && pwd)"
filename="$(awk -v arch="$architecture" '$2 ~ ("^node-v[0-9.]+-darwin-" arch "\\.tar\\.gz$") {print $2}' "$resources/SHASUMS256.txt")"
[[ "$filename" =~ ^node-v[0-9.]+-darwin-(arm64|x64)\.tar\.gz$ ]] || { echo "Node.js não localizado."; exit 1; }
awk -v file="$filename" '$2 == file' "$resources/SHASUMS256.txt" > "$work/checksum.txt"
(cd "$resources" && /usr/bin/shasum -a 256 -c "$work/checksum.txt")
tar -xzf "$resources/$filename" -C "$destination" --strip-components=1
export PATH="$destination/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export npm_config_cache="$work/npm-cache"
export npm_config_offline=true
export npm_config_update_notifier=false
export npm_config_registry=https://registry.npmjs.org
export npm_config_userconfig="$work/user.npmrc"
export npm_config_globalconfig="$work/global.npmrc"
echo "Instalando Moon e dependências..."
tar -xzf "$sdk_archive" -C "$destination"
ln -sfn ../lib/node_modules/@moon/sdk/bin/moon.mjs "$destination/bin/moon"
chmod 755 "$destination/lib/node_modules/@moon/sdk/bin/moon.mjs"
node --version
npm --version
npm ls --global --prefix "$destination" --depth=0
moon --help
node --input-type=module -e 'await import(process.argv[1])' "$destination/lib/node_modules/@moon/sdk/dist/index.js"
test -f "$destination/lib/node_modules/@base44/sdk/package.json"
