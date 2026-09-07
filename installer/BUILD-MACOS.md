# Instalador macOS

Execute `bash installer/build-macos.sh` em um Mac com Node.js 22 para gerar
`Moon-SDK-Installer.pkg`. O build compila e inclui o SDK deste checkout,
sem depender de uma publicação de @moon/sdk no npm.

O usuário abre o pacote no Installer e autoriza a instalação. Não é necessário
ter Node.js previamente. A instalação precisa de internet para baixar o Node.js
22 e as dependências npm. O tarball do Node é verificado pelo SHA-256 oficial.

O runtime fica em /usr/local/lib/moon-sdk/releases. A versão atual só é
ativada depois que Node, npm, moon --help e a importação do SDK passam.
Reinstalações mantêm a versão anterior. O launcher /usr/local/bin/moon usa
o runtime próprio; instalações existentes de Node não são substituídas.
O arquivo /etc/paths.d/moon-sdk contém caminhos, um por linha.
Abra um novo Terminal após a instalação para atualizar o PATH.

Falhas detalhadas ficam em /var/log/moon-sdk-installer.log. O workflow testa
instalação e reinstalação antes de publicar, independentemente do Windows.
O pacote ainda não é assinado nem notarizado com certificado Apple.
