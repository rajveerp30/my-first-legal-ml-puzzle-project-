@echo off
title Puzzle Hands - Local Server
cd /d "%~dp0"

echo ============================================
echo   Puzzle Hands - starting local server
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found on this computer.
    echo Please install it from https://nodejs.org (LTS version) and run this file again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing dependencies for the first time, this can take a minute...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed. Scroll up to see what went wrong.
        pause
        exit /b 1
    )
    echo.
)

echo Starting the app...
echo Once it says "Ready", open this address in your browser:
echo     http://localhost:3000
echo.
echo Your webcam will ask for permission the first time - allow it.
echo Press CTRL+C in this window to stop the server.
echo.

call npm run dev

pause
