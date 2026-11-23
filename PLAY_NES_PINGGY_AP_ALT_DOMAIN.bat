@echo off
title Netplay Deck - Pinggy AP Alt Domain (free.pinggy.net)
cd /d "%~dp0"
set "PS=%~dp0start_online.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" ^
  -Tunnel pinggy -Region ap -TunnelHost lin.ap.4.a.pinggy.click ^
  -PreferDomain free.pinggy.net
pause
