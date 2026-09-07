# Instalador macOS

Execute `bash installer/build-macos.sh` em um Mac com Node.js 22 para gerar
`Moon-SDK-Installer.pkg`. O build compila e inclui o SDK deste checkout,
sem depender de uma publicação de @moon/sdk no npm.

O usuário abre o pacote no Installer e autoriza a instalação. Não é necessário
ter Node.js previamente. O pacote é pequeno e baixa do GitHub Releases o Node.js
22.23.2 da arquitetura do Mac e o Moon com todas as dependências prontas, além do Base44.
É necessário acesso à internet durante a instalação; não há npm install no Mac.
As dependências do Moon são preparadas com package-lock.json no build.
Cada download é validado pelo SHA-256 gravado dentro do instalador.

O build também gera macos-resources/. O workflow publica esses arquivos numa
release de recursos exclusiva para cada execução (macos-resources-RUN-ATTEMPT),
antes de testar instalação e reinstalação via download. Só depois publica o
Moon-SDK-Installer.pkg na release latest (ou tag escolhida manualmente).
As releases de recursos são pré-releases e não substituem a release principal.
Não apague nem substitua os recursos: instaladores antigos usam as URLs e hashes
da sua própria versão. Para build manual, defina RESOURCE_TAG e publique os
arquivos de macos-resources nessa tag antes de distribuir o pacote.

O runtime fica em /usr/local/lib/moon-sdk/releases. A versão atual só é
ativada depois que Node, npm, moon --help e a importação do SDK passam.
Reinstalações mantêm a versão anterior. O launcher /usr/local/bin/moon usa
o runtime próprio; instalações existentes de Node não são substituídas.
O arquivo /etc/paths.d/moon-sdk contém caminhos, um por linha.
Abra um novo Terminal após a instalação para atualizar o PATH.

Falhas detalhadas ficam em /var/log/moon-sdk-installer.log. O workflow testa
instalação e reinstalação antes de publicar, independentemente do Windows.
O pacote ainda não é assinado nem notarizado com certificado Apple.
