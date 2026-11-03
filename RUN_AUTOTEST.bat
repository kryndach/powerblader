@echo off
title NES Online - 2-PC Zero-Click Auto-Benchmark (localhost.run)
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_online.ps1" -Tunnel localhost.run -Mode autotest
pause
