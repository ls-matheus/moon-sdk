# Instalador Windows sem administrador

Compile `installer/install.iss` com Inno Setup 6 ou superior. O workflow fixa o commit do SDK e publica `install.exe` depois dos testes de instalação e reinstalação.

O instalador usa `PrivilegesRequired=lowest`: não solicita UAC nem senha de administrador. Por padrão, instala em `%LOCALAPPDATA%\Programs\Moon SDK`.

- Baixa Node.js 22.23.2 portátil e confere seu SHA-256, sem executar MSI.
- Instala as dependências do Moon com `npm ci` e o lockfile do commit.
- Usa o proxy do Windows nos downloads e configura o proxy do npm quando necessário.
- Ativa uma nova pasta de versão somente depois de validar `moon --help`.
- Adiciona apenas a pasta `bin` do Moon ao PATH do usuário; preserva o PATH do sistema e outras instalações de Node/npm.
- Registra um desinstalador por usuário, que remove os arquivos próprios e sua entrada no PATH.

Abra um novo terminal depois da instalação. O log fica em `install.log` na pasta escolhida. A instalação exige internet. O CLI oficial Base44 é preparado quando `moon login` ou `moon eject` precisar dele.

Instalações antigas feitas como administrador permanecem separadas; removê-las ainda pode exigir autorização de administrador. Para outros sistemas, veja [BUILD-MACOS.md](BUILD-MACOS.md).
