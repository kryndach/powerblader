@echo off
title NES Online - Backup SSH Tunnel (localhost.run)
cd /d "%~dp0"
set "PS=%~dp0start_online.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" ^
  -Tunnel localhost.run
pause
