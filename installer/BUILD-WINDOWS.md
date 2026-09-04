# Gerar o `install.exe`

O instalador visual é definido em `install.iss`. Para gerar o executável em um Windows, basta executar `build-installer.cmd`; ele instala o Inno Setup automaticamente via winget quando necessário e compila o instalador.

O `install.exe` não embute uma cópia do SDK: durante a instalação ele baixa a branch `main` diretamente de `https://github.com/ls-matheus/moon-sdk`, extrai os arquivos e instala a versão atual publicada no repositório. O computador precisa estar conectado à internet.

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
- cria um atalho visual para preparar projetos.

O instalador usa uma única base do Moon SDK. O arquivo `setup-moon.bat` continua existindo somente como compatibilidade para instalações antigas; a lógica compartilhada está em `bin/setup.mjs`.
