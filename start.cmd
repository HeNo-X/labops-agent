@echo off
rem ===========================================================================
rem  LabOps Agent - one-click launcher (Windows)
rem  Double-click this file. It will:
rem    1) check the environment
rem    2) install dependencies if missing
rem    3) build the frontend if missing
rem    4) start the server and open the browser
rem  Close this window to stop the server.
rem
rem  NOTE: keep this file ASCII-only and CRLF. Chinese text inside .cmd files
rem        gets garbled by the console codepage (learned the hard way).
rem ===========================================================================
setlocal
cd /d "%~dp0"
title LabOps Agent

echo.
echo  =====================================================================
echo   LabOps Agent - Lab Task Canvas
echo  =====================================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo  [ERROR] Node.js not found.
    echo          This project needs Node 22.18 or newer.
    echo          Download: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not defined PORT set PORT=8787

node scripts\check-env.mjs
if errorlevel 1 (
    echo.
    echo  Environment check failed. Nothing was started.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo  [1/2] Installing dependencies. This can take a minute...
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo  [ERROR] npm install failed. See the messages above.
        pause
        exit /b 1
    )
    echo.
)

if not exist "dist\index.html" (
    echo  [2/2] Building frontend...
    echo.
    call npm run build
    if errorlevel 1 (
        echo.
        echo  [ERROR] Frontend build failed. See the messages above.
        pause
        exit /b 1
    )
    echo.
)

echo  Starting server. Close this window to stop it.
echo.

rem Open the browser a few seconds later, in a minimized helper window,
rem so the user does not stare at a connection-refused page.
rem LABOPS_NO_BROWSER=1 skips this (used by automated checks).
if not defined LABOPS_NO_BROWSER (
    start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:%PORT%"
)

node server\index.ts

echo.
echo  Server stopped.
pause
