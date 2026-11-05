@echo off
title NES Online - 2-Player Game Launcher (Pinggy EU / Frankfurt Edge)
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_online.ps1" -Tunnel pinggy -Region eu -Mode game
pause
