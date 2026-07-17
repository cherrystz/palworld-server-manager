@echo off
title Palworld Web Dashboard Manager
color 0b

echo =======================================================
echo           Palworld Server Web Dashboard Manager
echo =======================================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org and try again.
    pause
    exit /b 1
)

:: Check if node_modules exists, if not run npm install
if not exist "node_modules\" (
    echo [INFO] First run detected. Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies!
        pause
        exit /b 1
      )
)

echo.
echo [INFO] Starting Web Dashboard on Port 31742...
echo.
echo -------------------------------------------------------
echo.
node index.js
echo.
echo -------------------------------------------------------
echo [INFO] Dashboard stopped.
pause
