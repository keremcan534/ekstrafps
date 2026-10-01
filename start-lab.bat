@echo off
rem Weapon Lab one-click launcher (Windows): installs dependencies on first run,
rem starts the dev server and opens the lab in your default browser.
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies...
  call npm install || (pause & exit /b 1)
)
echo Starting Weapon Lab on http://localhost:5173  (phones on the same Wi-Fi: use this PC's IP)
call npm run lab
pause
