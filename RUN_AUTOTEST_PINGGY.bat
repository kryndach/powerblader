@echo off
title NES Online - 2-PC Zero-Click Auto-Benchmark (Pinggy Tunnel)
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_online.ps1" -Tunnel pinggy -Mode autotest
pause
