@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo Created .env - open it in Notepad, paste your ANTHROPIC_API_KEY, save, then run start.bat again.
  notepad .env
  pause
  exit /b 0
)
if not exist node_modules (
  echo Installing dependencies, this takes a minute the first time...
  call npm install --omit=dev
  if errorlevel 1 ( pause & exit /b 1 )
)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node server.js
pause
