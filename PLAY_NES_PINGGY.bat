@echo off
title NES Online - One-Click 2-Player Game Launcher (Pinggy Low-Latency Tunnel)
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_online.ps1" -Tunnel pinggy -Mode game
pause
