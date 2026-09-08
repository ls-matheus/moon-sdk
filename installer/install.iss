; Per-user installer: no UAC, MSI or machine-wide environment changes.
#define MoonVersion "0.2.0"
#ifndef MoonCommit
  #define MoonCommit "main"
#endif

[Setup]
AppId=MoonSDK-User
AppName=Moon SDK
AppVersion={#MoonVersion}
AppPublisher=Moon
DefaultDirName={localappdata}\Programs\Moon SDK
DefaultGroupName=Moon SDK
OutputDir=..\
OutputBaseFilename=install
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesEnvironment=yes
UninstallDisplayName=Moon SDK (usuario atual)

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
Source: "install-user.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Desinstalar Moon SDK"; Filename: "{uninstallexe}"

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-user.ps1"" -Destination ""{app}"" -Uninstall"; Flags: runhidden waituntilterminated

[UninstallDelete]
Type: filesandordirs; Name: "{app}\releases"
Type: filesandordirs; Name: "{app}\bin"
Type: files; Name: "{app}\install.log"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
begin
  if CurStep = ssPostInstall then begin
    WizardForm.StatusLabel.Caption := 'Instalando Node portatil e Moon para seu usuario...';
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      ExpandConstant('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{app}\install-user.ps1" -Destination "{app}" -Commit "{#MoonCommit}"'),
      '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
      RaiseException('Nao foi possivel iniciar a instalacao.');
    if ExitCode <> 0 then
      RaiseException(ExpandConstant('Instalacao falhou. Consulte {app}\install.log e execute o instalador novamente.'));
  end;
end;
