@echo off
setlocal

rem Compila o instalador no Windows. O Inno Setup é instalado automaticamente se necessário.
where iscc.exe >nul 2>nul
if errorlevel 1 (
  where winget.exe >nul 2>nul
  if errorlevel 1 (
    echo winget nao foi encontrado. Instale o Inno Setup manualmente em https://jrsoftware.org/isdl.php
    exit /b 1
  )
  echo Instalando o Inno Setup Compiler...
  winget install --id JRSoftware.InnoSetup.7 -e -s winget -i
  if errorlevel 1 exit /b 1
)

for /f "delims=" %%I in ('where iscc.exe') do set "ISCC=%%I"
"%ISCC%" "%~dp0install.iss"
if errorlevel 1 exit /b 1
echo.
echo Instalador criado em: %~dp0..\install.exe
endlocal
