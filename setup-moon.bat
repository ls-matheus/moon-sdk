@echo off
rem Compatibilidade com instalações Windows antigas.
rem A lógica compartilhada fica em bin/setup.mjs e também funciona no macOS.
node "%~dp0bin\setup.mjs" %*
