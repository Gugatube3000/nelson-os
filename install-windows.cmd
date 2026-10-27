@echo off
setlocal
title Nelson OS setup
cd /d "%~dp0"
echo.
echo   Nelson OS setup
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   Installing Node.js, needed once. Windows may ask for permission.
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js could not be installed automatically. Install the LTS version from https://nodejs.org and double-click this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
node scripts\setup.mjs
echo.
pause
