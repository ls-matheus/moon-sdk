on run
    set titleText to "Instalador Moon SDK"
    display dialog "Este instalador configura o Moon SDK e o Base44 SDK para todos os usuários deste Mac." buttons {"Cancelar", "Instalar"} default button "Instalar" with title titleText

    try
        do shell script "/usr/bin/env bash -lc 'command -v node >/dev/null 2>&1'"
    on error
        display dialog "Node.js não foi encontrado. Instale o Node.js LTS em nodejs.org e execute este instalador novamente." buttons {"OK"} default button "OK" with title titleText
        return
    end try

    display dialog "A instalação pode solicitar a senha de administrador." buttons {"Cancelar", "Continuar"} default button "Continuar" with title titleText
    try
        do shell script "/usr/bin/env bash -lc 'npm install --global @moon/sdk @base44/sdk'" with administrator privileges
        display dialog "Moon SDK instalado com sucesso." buttons {"OK"} default button "OK" with title titleText
    on error errorMessage number errorNumber
        display dialog "A instalação falhou (" & errorNumber & "):" & return & errorMessage buttons {"OK"} default button "OK" with title titleText
    end try
end run
