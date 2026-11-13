@echo off
rem Starts Jarvis. (After setup, you can also use the Jarvis shortcut in the Start menu.)
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Jarvis isn't installed yet. Run setup.cmd first.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
