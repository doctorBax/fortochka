@echo off
rem tgweb-desktop launcher: Electron + webk + tg-ws-proxy-rs
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [!] Electron not installed. Run: npm install
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
