@echo off
title Discord Bot - Starting...

cd /d "%~dp0"

:: Check if already running
if exist bot.pid (
    set /p OLD_PID=<bot.pid
    tasklist /FI "PID eq %OLD_PID%" 2>nul | findstr /I "node.exe" >nul
    if not errorlevel 1 (
        echo Bot is already running (PID %OLD_PID%)
        pause
        exit /b 1
    ) else (
        echo Stale PID file found, cleaning up...
        del bot.pid
    )
)

echo Starting bot...
start /b node src/index.js

:: Give it a moment to start and grab the PID
timeout /t 3 /nobreak >nul

for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq node.exe" /FO LIST ^| findstr "PID:"') do (
    echo %%a> bot.pid
    echo Bot started (PID %%a)
)

echo Use stop.bat to shut it down.
pause
