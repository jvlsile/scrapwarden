@echo off
REM Scrapwarden para Windows. Requiere Node.js 18+ (https://nodejs.org)
cd /d "%~dp0"
where node >nul 2>nul || (echo Instala Node.js 18 o superior desde https://nodejs.org && pause && exit /b 1)
if not exist node_modules (
  echo Instalando dependencias...
  call npm install --omit=dev
)
echo Abriendo http://localhost:8080
start "" http://localhost:8080
node server.js
pause
