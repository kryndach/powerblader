@echo off
title NES Online - Pinggy SG Node 1 (139.162.x + pinggy-free.link)
cd /d "%~dp0"
set "PS=%~dp0start_online.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" ^
  -Tunnel pinggy -Region ap -TunnelHost lin.ap.1.a.pinggy.click ^
  -PreferDomain pinggy-free.link
pause
