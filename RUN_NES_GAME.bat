@echo off
title NES Online - 2-Player Co-op Game Console
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_online.ps1" -Tunnel localhost.run -Mode game
pause
