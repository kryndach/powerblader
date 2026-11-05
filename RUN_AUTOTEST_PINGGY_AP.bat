@echo off
title NES Online - 2-PC Auto-Benchmark (Pinggy ASIA-PACIFIC ap.a.pinggy.io)
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_online.ps1" -Tunnel pinggy -Region ap -Mode autotest
pause
