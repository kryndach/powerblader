@echo off
title NES Online - 2-PC Interactive Block Sandbox & Workbench (localhost.run Tunnel)
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_online.ps1" -Tunnel localhost.run -Mode nettest
pause
