#!/bin/bash
set -euo pipefail

echo "Instalando Moon SDK..."
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js não encontrado. Instale a versão LTS em https://nodejs.org e execute novamente."
  read -r -p "Pressione Enter para fechar..."
  exit 1
fi
npm install --global @moon/sdk @base44/sdk
echo "Moon SDK instalado com sucesso."
read -r -p "Pressione Enter para fechar..."
