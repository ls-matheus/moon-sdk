# Gerar o `install.exe`

O instalador visual é definido em `install.iss`. Para gerar o executável em um Windows, abra o arquivo no Inno Setup e compile.

O `install.exe` gerado pelo workflow embute o commit exato que disparou o build. Durante a instalação, ele baixa o arquivo ZIP desse commit em `https://github.com/ls-matheus/moon-sdk`, extrai os arquivos e instala a mesma versão validada pelo CI. Builds manuais usam `main` como fallback. O computador precisa estar conectado à internet.

O workflow `release-installer.yml` recompila o instalador em todo push para `main` e atualiza a release `latest`, substituindo o `install.exe` anterior. Uma execução manual permite criar uma release com uma tag própria, como `v1.0.0`.

O mesmo workflow também gera `Moon-SDK-Installer.pkg` em um runner macOS. Abra o arquivo para usar o instalador nativo do macOS. O pacote leve baixa do GitHub os recursos versionados (Node.js, Moon SDK, Base44 SDK e dependências prontas), verifica os checksums e configura o PATH automaticamente.

Os builds são independentes: cada instalador é publicado na Release assim que seu próprio job termina, sem esperar a outra plataforma. Veja [BUILD-MACOS.md](BUILD-MACOS.md) para detalhes do pacote macOS e dos testes de instalação.

Também é possível compilar manualmente:

1. Instale o Inno Setup 7.
2. Abra `install.iss` no Inno Setup.
3. Clique em **Compile**.

O arquivo será criado em `SDKs/moon-sdk/install.exe`.

O instalador exige privilégios de administrador e faz o seguinte automaticamente:

- instala Node.js LTS;
- instala o `@moon/sdk` e o `@base44/sdk`;
- instala as dependências transitivas dos SDKs;
- usa o prefixo global padrão do usuário para substituir launchers antigos do npm;
- registra o SDK e o npm global no PATH do sistema;
- cria um desinstalador nativo no Menu Iniciar;
- remove os caminhos do Moon do PATH ao desinstalar.

O instalador usa uma única base do Moon SDK e não depende de launchers auxiliares no repositório.
