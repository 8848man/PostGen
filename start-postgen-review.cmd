@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it and try again.
  pause
  exit /b 1
)
node "%~dp0scripts\open-review.mjs" %*
if errorlevel 1 pause
