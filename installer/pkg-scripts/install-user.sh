#!/bin/bash
set -euo pipefail
[[ "$(uname -s)" = Darwin ]] || { echo 'Este instalador requer macOS.' >&2; exit 1; }
[[ "$EUID" != 0 ]] || { echo 'Execute como seu usuario, sem sudo.' >&2; exit 1; }
scripts="$(cd "$(dirname "$0")" && pwd)"
root="$HOME/Library/Application Support/Moon SDK"
mkdir -p "$root/releases" "$HOME/.local/bin"
exec > >(tee -a "$root/install.log") 2>&1
release="$(mktemp -d "$root/releases/install.XXXXXX")"
/bin/bash "$scripts/install-runtime.sh" "$release" "$scripts"
# Generate the launcher before activation; keep previous releases for recovery.
{
  printf '#!/bin/bash\n'
  printf 'runtime=%q\n' "$release"
  printf 'export PATH="$runtime/bin:$PATH"\n'
  printf 'exec "$runtime/bin/node" "$runtime/lib/node_modules/@moon/sdk/bin/moon.mjs" "$@"\n'
} > "$release/moon-launcher"
chmod 755 "$release/moon-launcher"
mv -f "$release/moon-launcher" "$HOME/.local/bin/moon"
path_line='export PATH="$HOME/.local/bin:$PATH" # Moon SDK user install'
for profile in "$HOME/.zprofile" "$HOME/.bash_profile"; do
  touch "$profile"
  if ! /usr/bin/grep -Fqx "$path_line" "$profile"; then
    printf '\n%s\n' "$path_line" >> "$profile"
  fi
done
if "$HOME/.local/bin/moon" --help; then
  echo 'Moon instalado sem administrador. Abra um novo Terminal e execute moon --help.'
else
  echo 'Falha na ativação do launcher do Moon. Capturando diagnósticos de setup:' >&2
  echo "PATH=$PATH" >&2
  echo 'Conteúdo de $HOME/.local/bin:' >&2
  ls -al "$HOME/.local/bin" >&2 || true
  echo "Conteúdo do release ($release):" >&2
  ls -al "$release" >&2 || true
  echo 'Últimas linhas do log de instalação:' >&2
  tail -n 200 "$root/install.log" >&2 || true
  echo 'Fim dos diagnósticos.' >&2
  exit 1
fi
