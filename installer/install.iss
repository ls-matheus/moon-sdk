; Instalador visual oficial do Moon SDK.
; Gere SDKs/moon-sdk/install.exe abrindo este arquivo no Inno Setup 6 no Windows.

#define MoonVersion "0.1.0"
#define MoonRepository "https://github.com/ls-matheus/moon-sdk/archive/refs/heads/main.zip"

[Setup]
AppId={{C4E8C18E-7C0E-4D14-9A1F-1B5C1B6A4B90}
AppName=Moon SDK
AppVersion={#MoonVersion}
AppPublisher=Moon
DefaultDirName={autopf}\Moon SDK
DefaultGroupName=Moon SDK
OutputDir=..\
OutputBaseFilename=install
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
Uninstallable=no

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Run]
; O SDK é baixado primeiro para deixar claro que a instalação usa a versão do GitHub.
Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -Command ""$ErrorActionPreference='Stop'; $zip=Join-Path $env:TEMP 'moon-sdk.zip'; $tmp=Join-Path $env:TEMP 'moon-sdk-extract'; if (Test-Path $tmp) {{ Remove-Item $tmp -Recurse -Force }}; Invoke-WebRequest -UseBasicParsing '{#MoonRepository}' -OutFile $zip; if (!(Test-Path $zip)) {{ throw 'Download do Moon SDK falhou.' }}; Expand-Archive -Path $zip -DestinationPath $tmp -Force; $source=Join-Path $tmp 'moon-sdk-main'; if (!(Test-Path $source)) {{ throw 'O arquivo do GitHub não contém moon-sdk-main.' }}; New-Item -ItemType Directory -Path '{app}\sdk' -Force | Out-Null; Copy-Item (Join-Path $source '*') '{app}\sdk' -Recurse -Force; Remove-Item $zip -Force -ErrorAction SilentlyContinue; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue"""; StatusMsg: "Baixando Moon SDK do GitHub..."; Flags: runhidden waituntilterminated
; Node.js LTS é baixado e instalado de forma silenciosa antes das dependências.
Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -Command ""$ErrorActionPreference='Stop'; $u='https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi'; $p=Join-Path $env:TEMP 'moon-node.msi'; Invoke-WebRequest -UseBasicParsing $u -OutFile $p; $r=Start-Process msiexec.exe -ArgumentList '/i',$p,'/qn','/norestart' -Wait -PassThru; Remove-Item $p -Force -ErrorAction SilentlyContinue; if ($r.ExitCode -ne 0) {{ exit $r.ExitCode }}"""; StatusMsg: "Baixando e instalando Node.js LTS..."; Flags: runhidden waituntilterminated
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -Command ""$npm=(Get-Command npm.cmd -ErrorAction Stop).Source; & $npm config set prefix '{app}\global' --global; & $npm install --global '{app}\sdk' '@base44/sdk'"""; StatusMsg: "Instalando Moon SDK, Base44 SDK e dependências..."; Flags: runhidden waituntilterminated

[Registry]
; PATH do sistema: a instalação fica disponível para CMD, PowerShell e novos terminais.
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\sdk;{app}\global;{app}\global\node_modules\.bin"; Flags: preservestringtype uninsdeletevalue

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    MsgBox('Moon SDK instalado com sucesso.'#13#10#13#10 +
      'Abra um novo terminal para que o PATH seja atualizado.'#13#10 +
      'O comando moon já estará disponível nos novos terminais.', mbInformation, MB_OK);
end;
