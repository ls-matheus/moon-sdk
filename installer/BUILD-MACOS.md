# Instaladores macOS

Execute `bash installer/build-macos.sh` em um Mac com Node.js 22. O build gera duas opções:

- `Moon-SDK-User-Installer.zip`: extraia e abra `Moon-SDK-Install.command`. Instala apenas para o usuário atual, sem `sudo` ou senha de administrador.
- `Moon-SDK-Installer.pkg`: instalação para o sistema, com autorização de administrador.

A opção por usuário guarda as versões em `~/Library/Application Support/Moon SDK/releases`, cria `~/.local/bin/moon` e adiciona essa pasta ao PATH em `.zprofile` e `.bash_profile`, sem duplicar a linha nas reinstalações. Abra um novo Terminal depois de instalar. O log fica em `~/Library/Application Support/Moon SDK/install.log`.

O `.pkg` usa `/usr/local/lib/moon-sdk/releases`, `/usr/local/bin/moon` e `/etc/paths.d/moon-sdk`. Seu log fica em `/var/log/moon-sdk-installer.log`.

Ambos baixam Node.js 22.23.2 para a arquitetura do Mac e o SDK com dependências prontas. Não é necessário Node previamente instalado nem executar npm install no Mac. Cada download é validado pelos hashes SHA-256 embutidos. A versão anterior é preservada; a nova só é ativada depois de validar Node, npm, o CLI e a importação do SDK.

O workflow publica `macos-resources/` numa release exclusiva por execução, testa instalação e reinstalação das duas opções e só então publica os instaladores. Não remova essas releases de recursos: instaladores antigos dependem de suas URLs e hashes. Em builds manuais, defina `RESOURCE_TAG` e publique os recursos nessa tag antes de distribuir os instaladores.

Os instaladores ainda não são assinados nem notarizados com certificado Apple. A instalação por usuário não altera políticas de segurança do macOS ou da organização.
