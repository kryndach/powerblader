@echo off
title NES Online - 2-Player Game Launcher (Pinggy AP / Singapore Edge)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_online.ps1"
pause
