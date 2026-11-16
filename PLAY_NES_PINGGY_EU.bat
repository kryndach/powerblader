@echo off
title NES Online - Pinggy Europe Midpoint (eu.a.pinggy.io)
cd /d "%~dp0"
set "PS=%~dp0start_online.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" ^
  -Tunnel pinggy -Region eu -TunnelHost eu.a.pinggy.io ^
  -PreferDomain pinggy-free.link
pause
