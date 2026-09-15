@echo off
title CardKingdom Server
color 0A
echo.
echo  =============================================
echo   CardKingdom Multiplayer Server
echo   Tien Len ^& Katte
echo  =============================================
echo.

:: Check if node is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] Node.js is not installed!
    echo  Download it from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Install packages if node_modules missing
if not exist "node_modules\" (
    echo  [INFO] First run - installing packages...
    echo.
    npm install
    echo.
)

:: Show local IP for friends on same WiFi
echo  [INFO] Your Local IP (same WiFi):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set ip=%%a
    setlocal enabledelayedexpansion
    set ip=!ip: =!
    echo          ws://!ip!:3000
    endlocal
)

echo.
echo  [INFO] For internet play, double-click: run_ngrok.bat
echo.
echo  =============================================
echo   Server starting on ws://localhost:3000
echo   Press Ctrl+C to stop
echo  =============================================
echo.

node server.js

echo.
echo  Server stopped.
pause
