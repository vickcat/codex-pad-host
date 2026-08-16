@echo off
rem ============================================================
rem start.bat - one-click start for Codex Peripheral Host Bridge
rem Double-click this file to start the server (window shows logs).
rem Close the window to stop. For hidden startup use setup.ps1 -Autostart
rem ============================================================
title Codex Peripheral Host Bridge
cd /d "%~dp0"

echo [host] checking node...
node --version >nul 2>&1
if errorlevel 1 (
    echo [host] ERROR: Node.js not found. Run setup.ps1 first or install from https://nodejs.org
    pause
    exit /b 1
)

echo [host] starting server (WS 8765 + UDP 8766)...
echo [host] close this window to stop.
echo.
node src/server.mjs
echo.
echo [host] server exited.
pause
