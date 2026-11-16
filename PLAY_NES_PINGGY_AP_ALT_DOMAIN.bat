@echo off
title NES Online - Pinggy SG Alt Domain (172.105.x + free.pinggy.net)
cd /d "%~dp0"
set "PS=%~dp0start_online.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" ^
  -Tunnel pinggy -Region ap -TunnelHost lin.ap.4.a.pinggy.click ^
  -PreferDomain free.pinggy.net
pause
