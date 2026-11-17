@echo off
title NES Online - Auto-Detect Fastest Tunnel Route (+ Live UI Switcher)
cd /d "%~dp0"
set "PS=%~dp0start_online.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" -Route auto
pause
