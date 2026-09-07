on run
    set titleText to "Moon SDK"
    display dialog "Este instalador vai preparar o Mac para usar o Moon SDK, incluindo Node.js, PATH e os SDKs necessários." buttons {"Cancelar", "Instalar"} default button "Instalar" with title titleText
    display dialog "A instalação pode levar alguns minutos e solicitar a senha de administrador." buttons {"Cancelar", "Continuar"} default button "Continuar" with title titleText

    set installScript to "set -e\n" & ¬
        "arch=$(uname -m)\n" & ¬
        "case \"$arch\" in arm64) node_arch=arm64;; x86_64) node_arch=x64;; *) echo 'Arquitetura não suportada'; exit 1;; esac\n" & ¬
        "node_pkg=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE 'node-v[0-9.]+-darwin-'\"$node_arch\"'\\.tar.gz' | head -1)\n" & ¬
        "[ -n \"$node_pkg\" ] || { echo 'Não foi possível encontrar o Node.js LTS'; exit 1; }\n" & ¬
        "tmp_pkg=$(mktemp /tmp/moon-node.XXXXXX.pkg)\n" & ¬
        "trap 'rm -f \"$tmp_pkg\"' EXIT\n" & ¬
        "curl -fL \"https://nodejs.org/dist/latest-v22.x/$node_pkg\" -o \"$tmp_pkg\"\n" & ¬
        "node_dir=/usr/local/lib/nodejs/\"${node_pkg%.tar.gz}\"\n" & ¬
        "mkdir -p \"$node_dir\" /usr/local/bin\n" & ¬
        "tar -xzf \"$tmp_pkg\" -C \"$node_dir\" --strip-components=1\n" & ¬
        "ln -sf \"$node_dir/bin/node\" /usr/local/bin/node\n" & ¬
        "ln -sf \"$node_dir/bin/npm\" /usr/local/bin/npm\n" & ¬
        "ln -sf \"$node_dir/bin/npx\" /usr/local/bin/npx\n" & ¬
        "export PATH=\"/usr/local/bin:/opt/homebrew/bin:$PATH\"\n" & ¬
        "printf '%s\\n' 'export PATH=\"/usr/local/bin:/opt/homebrew/bin:$PATH\"' > /etc/paths.d/moon-sdk\n" & ¬
        "npm install --global @moon/sdk @base44/sdk >/dev/null 2>&1\n"

    try
        do shell script "/bin/bash -c " & quoted form of installScript with administrator privileges
        display dialog "Tudo pronto. Node.js, PATH, Moon SDK e Base44 SDK foram instalados." buttons {"Concluir"} default button "Concluir" with title titleText
    on error errorMessage number errorNumber
        display dialog "Não foi possível concluir a instalação. Verifique sua conexão e tente novamente." buttons {"OK"} default button "OK" with title titleText
    end try
end run
