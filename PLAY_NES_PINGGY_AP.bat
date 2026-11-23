@echo off
title Netplay Deck - Pinggy AP Node 1 (pinggy-free.link)
cd /d "%~dp0"
set "PS=%~dp0start_online.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" ^
  -Tunnel pinggy -Region ap -TunnelHost lin.ap.1.a.pinggy.click ^
  -PreferDomain pinggy-free.link
pause
