@echo off
title DiVA - Stopping...

cd /d "%~dp0"

if exist bot.pid (
    set /p BOT_PID=<bot.pid
    echo Stopping bot (PID %BOT_PID%)...
    taskkill /PID %BOT_PID% /F >nul 2>&1
    del bot.pid
    echo Bot stopped.
) else (
    echo No PID file found. Checking for running node processes...
    tasklist /FI "IMAGENAME eq node.exe" 2>nul | findstr /I "node.exe" >nul
    if not errorlevel 1 (
        echo Found node process, killing...
        taskkill /IM node.exe /F >nul 2>&1
        echo Done.
    ) else (
        echo No bot processes found.
    )
)

pause
