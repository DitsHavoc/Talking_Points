@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed or not on PATH.
  echo Install Node.js LTS, then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting Talking Points Classroom V2.4...
echo A fresh browser tab will open automatically.
echo DO NOT use an old localhost:3000 tab from an earlier version.
echo.
node server.js
pause
