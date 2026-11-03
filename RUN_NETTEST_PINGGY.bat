@echo off
title NES Online - 2-PC Interactive Block Sandbox & Workbench (Pinggy Tunnel)
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_online.ps1" -Tunnel pinggy -Mode nettest
pause
