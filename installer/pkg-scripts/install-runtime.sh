#!/bin/bash
set -euo pipefail
export LC_ALL=C
destination="$1"
resources="$2"
case "$(uname -m)" in
  arm64) architecture=arm64 ;;
  x86_64) architecture=x64 ;;
  *) echo "Arquitetura não suportada." >&2; exit 1 ;;
esac
mkdir -p "$destination"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
base_url="$(cat "$resources/resources-url.txt")"
[[ "$base_url" == https://github.com/*/releases/download/* ]] || { echo "URL de recursos inválida."; exit 1; }
filename="$(awk -v arch="$architecture" '$2 ~ ("^node-v[0-9.]+-darwin-" arch "\\.tar\\.gz$") {print $2}' "$resources/resources.sha256")"
[[ "$filename" =~ ^node-v[0-9.]+-darwin-(arm64|x64)\.tar\.gz$ ]] || { echo "Node.js não localizado."; exit 1; }
for asset in "$filename" moon-sdk.tgz; do
  echo "Baixando $asset do GitHub..."
  downloaded=false
  for attempt in 1 2 3 4 5; do
    if /usr/bin/curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 30 --max-time 600 "$base_url/$asset" -o "$work/$asset"; then
      downloaded=true
      break
    fi
    sleep 2
  done
  "$downloaded" || { echo "Falha ao baixar $asset. Verifique a conexão com o GitHub."; exit 1; }
  awk -v file="$asset" '$2 == file' "$resources/resources.sha256" > "$work/checksum.txt"
  [ "$(wc -l < "$work/checksum.txt" | tr -d ' ')" = 1 ] || { echo "Checksum ausente ou duplicado."; exit 1; }
  (cd "$work" && /usr/bin/shasum -a 256 -c checksum.txt)
done
tar -xzf "$work/$filename" -C "$destination" --strip-components=1
export PATH="$destination/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export npm_config_cache="$work/npm-cache"
export npm_config_offline=true
export npm_config_update_notifier=false
export npm_config_registry=https://registry.npmjs.org
export npm_config_userconfig="$work/user.npmrc"
export npm_config_globalconfig="$work/global.npmrc"
echo "Instalando Moon e dependências..."
tar -xzf "$work/moon-sdk.tgz" -C "$destination"
ln -sfn ../lib/node_modules/@moon/sdk/bin/moon.mjs "$destination/bin/moon"
chmod 755 "$destination/lib/node_modules/@moon/sdk/bin/moon.mjs"
node --version
npm --version
npm ls --global --prefix "$destination" --depth=0
moon --help
node --input-type=module -e 'await import(process.argv[1])' "$destination/lib/node_modules/@moon/sdk/dist/index.js"
test -f "$destination/lib/node_modules/@base44/sdk/package.json"
