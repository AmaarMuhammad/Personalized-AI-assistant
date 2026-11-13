@echo off
setlocal
title Jarvis setup
cd /d "%~dp0"

echo.
echo  Setting up Jarvis
echo  =================
echo.

rem ---- 1. Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed. Opening the download page...
  echo  Install the "LTS" version, then run setup.cmd again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 20 (
  echo  Your Node.js is too old. Please install the current LTS version from nodejs.org, then run setup.cmd again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
echo  [ok] Node.js found.

rem ---- 2. Jarvis's own files ----
echo.
echo  Installing Jarvis (this takes a minute or two)...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo  Installation failed. Check your internet connection and run setup.cmd again.
  pause
  exit /b 1
)
rem Electron 44 no longer downloads its program during npm install, so fetch it now.
echo  Downloading the Jarvis window program (about 160 MB)...
node "node_modules\electron\install.js"
if not exist "node_modules\electron\dist\electron.exe" (
  echo  The download did not finish. Check your internet connection and run setup.cmd again.
  pause
  exit /b 1
)
echo  [ok] Jarvis installed.

rem ---- 3. Start menu and desktop shortcuts ----
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-shortcuts.ps1"
echo  [ok] Shortcuts added to the Start menu and desktop.

echo.
echo  All done. Jarvis needs the Hermes gateway running. See README.md, "Install".
echo  Starting Jarvis...
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
endlocal
exit /b 0
