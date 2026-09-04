# Gerar o `install.exe`

O instalador visual é definido em `install.iss`. Para gerar o executável em um Windows, abra o arquivo no Inno Setup e compile.

O `install.exe` não embute uma cópia do SDK: durante a instalação ele baixa a branch `main` diretamente de `https://github.com/ls-matheus/moon-sdk`, extrai os arquivos e instala a versão atual publicada no repositório. O computador precisa estar conectado à internet.

O workflow `release-installer.yml` recompila o instalador em todo push para `main` e atualiza a release `latest`, substituindo o `install.exe` anterior. Uma execução manual permite criar uma release com uma tag própria, como `v1.0.0`.

Também é possível compilar manualmente:

1. Instale o Inno Setup 7.
2. Abra `install.iss` no Inno Setup.
3. Clique em **Compile**.

O arquivo será criado em `SDKs/moon-sdk/install.exe`.

O instalador exige privilégios de administrador e faz o seguinte automaticamente:

- instala Node.js LTS;
- instala o `@moon/sdk` e o `@base44/sdk`;
- instala as dependências transitivas dos SDKs;
- registra o SDK e o npm global no PATH do sistema;
- cria um desinstalador nativo no Menu Iniciar;
- remove os caminhos do Moon do PATH ao desinstalar.

O instalador usa uma única base do Moon SDK e não depende de launchers auxiliares no repositório.
