param(
  [ValidateSet("auto", "sg1", "sg2", "sg3", "sg4_alt", "eu", "lhr", "")]
  [string]$Route = "",
  [ValidateSet("localhost.run", "pinggy")]
  [string]$Tunnel = "pinggy",
  [ValidateSet("auto", "ap", "eu", "us")]
  [string]$Region = "ap",
  [string]$TunnelHost = "",
  [ValidateSet("pinggy-free.link", "free.pinggy.net", "any")]
  [string]$PreferDomain = "pinggy-free.link",
  [ValidateSet("autotest", "nettest", "game")]
  [string]$Mode = "game",
  [int]$Port = 8080
)

$ErrorActionPreference = "Continue"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

if ($Route -eq "") {
  if ($Tunnel -eq "localhost.run") { $Route = "lhr" }
  elseif ($Region -eq "eu") { $Route = "eu" }
  elseif ($TunnelHost -like "*lin.ap.3*") { $Route = "sg3" }
  elseif ($TunnelHost -like "*lin.ap.2*") { $Route = "sg2" }
  elseif ($TunnelHost -like "*lin.ap.4*" -or
          $PreferDomain -eq "free.pinggy.net") { $Route = "sg4_alt" }
  elseif ($TunnelHost -like "*lin.ap.1*") { $Route = "sg1" }
  else { $Route = "auto" }
}

$sep = "================================================================"
Write-Host ""
Write-Host $sep -ForegroundColor Cyan
Write-Host "   NES ONLINE -- AUTO-ROUTE & LIVE UI TUNNEL LAUNCHER" `
  -ForegroundColor Cyan
Write-Host $sep -ForegroundColor Cyan

# 1. Stop any existing process bound to $Port
$existingConns = Get-NetTCPConnection -LocalPort $Port -State Listen `
  -ErrorAction SilentlyContinue
if ($existingConns) {
  foreach ($conn in $existingConns) {
    $pidToKill = $conn.OwningProcess
    if ($pidToKill -and $pidToKill -gt 4) {
      Write-Host "[1/4] Stopping old server on port $Port ($pidToKill)..." `
        -ForegroundColor Yellow
      Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 600
}

# 2. Start Node.js Relay & Tunnel Manager Server
Write-Host "[2/4] Starting local Node.js Server on port $Port..." `
  -ForegroundColor Green
$logsDir = Join-Path $RootDir "logs"
$nodeOut = Join-Path $logsDir "server_stdout.log"
$nodeErr = Join-Path $logsDir "server_stderr.log"
if (!(Test-Path $logsDir)) {
  New-Item -ItemType Directory -Path $logsDir | Out-Null
}

$nodeProc = Start-Process -FilePath "node" `
  -ArgumentList "server/relay_server.mjs" `
  -WorkingDirectory $RootDir `
  -RedirectStandardOutput $nodeOut `
  -RedirectStandardError $nodeErr `
  -NoNewWindow `
  -PassThru

$serverReady = $false
$healthUrl = "http://localhost:$Port/api/health"
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 -ErrorAction Stop
    if ($resp.ok) { $serverReady = $true; break }
  } catch {}
}

if (-not $serverReady) {
  Write-Host "[ERROR] Server failed on port $Port (logs/server_stderr.log)." `
    -ForegroundColor Red
  if ($nodeProc -and !$nodeProc.HasExited) {
    Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue
  }
  exit 1
}
Write-Host "      Server is ONLINE at http://localhost:$Port" `
  -ForegroundColor Green

# 3. Probe & Activate Best Tunnel Route via Host Tunnel Manager API
Write-Host "[3/4] Probing & starting tunnel route '$Route'..." `
  -ForegroundColor Green
$routesUrl = "http://localhost:$Port/api/tunnel-routes"
$publicBaseUrl = $null
$altBaseUrl = $null
$activeLabel = $Route

try {
  $body = @{ route = $Route } | ConvertTo-Json -Compress
  $tRes = Invoke-RestMethod -Uri $routesUrl -Method Post -Body $body `
    -ContentType "application/json" -TimeoutSec 35 -ErrorAction Stop
  if ($tRes.routes) {
    Write-Host "      TCP 443 Edge Probe Results:" -ForegroundColor DarkCyan
    foreach ($r in $tRes.routes) {
      if ($r.isAuto -or $null -eq $r.rttMs) { continue }
      $mark = if ($r.id -eq $tRes.tunnelInfo.routeId) { " <-- ACTIVE" }
        else { "" }
      $col = if ($mark -ne "") { "Green" } else { "Gray" }
      Write-Host ("        - {0,-22}: {1,4} ms{2}" -f `
        $r.label, $r.rttMs, $mark) -ForegroundColor $col
    }
  }
  $publicBaseUrl = $tRes.tunnelInfo.publicUrl
  $altBaseUrl = $tRes.tunnelInfo.altUrl
  $activeLabel = "$($tRes.tunnelInfo.routeLabel) [$($tRes.tunnelInfo.region)]"
} catch {
  Write-Host "[WARN] Tunnel activation warning: $($_.Exception.Message)" `
    -ForegroundColor Yellow
}

$pathSuffix = "/autotest"
if ($Mode -eq "nettest") { $pathSuffix = "/nettest?room=NOVA" }
if ($Mode -eq "game") { $pathSuffix = "/?room=NOVA" }

$localUrl = "http://localhost:$Port$pathSuffix"
$lastShownPublicUrl = $publicBaseUrl

if ($publicBaseUrl) {
  $broUrl = "$publicBaseUrl$pathSuffix"
  try { Set-Clipboard -Value $broUrl } catch {}

  Write-Host ""
  Write-Host $sep -ForegroundColor Green
  Write-Host "   READY! YOU CAN ALSO SWITCH ROUTES LIVE IN THE TOP BAR!" `
    -ForegroundColor Green
  Write-Host $sep -ForegroundColor Green
  Write-Host ""
  Write-Host "  1. SEND THIS LINK TO BROTHER (Copied to Clipboard!):" `
    -ForegroundColor Yellow
  Write-Host "     $broUrl" -ForegroundColor White
  if ($altBaseUrl) {
    Write-Host "     Alt Domain: $altBaseUrl$pathSuffix" `
      -ForegroundColor DarkGray
  }
  Write-Host ""
  Write-Host "  2. YOUR LOCAL LINK (Opening in your browser now...):" `
    -ForegroundColor Cyan
  Write-Host "     $localUrl" -ForegroundColor White
  Write-Host ""
  Write-Host "  Active Route: $activeLabel" -ForegroundColor Gray
  Write-Host $sep -ForegroundColor Green
} else {
  Write-Host "[WARN] No public tunnel URL yet -- pick a Route in the UI!" `
    -ForegroundColor Yellow
  Write-Host "Local URL: $localUrl" -ForegroundColor Cyan
}

# 4. Open local browser automatically
Write-Host "[4/4] Opening $localUrl in your default browser..." `
  -ForegroundColor Green
Start-Process $localUrl

$infoUrl = "http://localhost:$Port/api/tunnel-info"
Write-Host ""
Write-Host "Server & Tunnel Manager active (switch routes anytime in UI)." `
  -ForegroundColor Cyan
Write-Host "Press Ctrl+C at any time to stop Server and SSH Tunnel." `
  -ForegroundColor DarkGray
Write-Host ""

try {
  while ($true) {
    Start-Sleep -Seconds 2
    if ($nodeProc.HasExited) {
      Write-Host "[ERROR] Node.js server exited unexpectedly." `
        -ForegroundColor Red
      break
    }
    try {
      $inf = Invoke-RestMethod -Uri $infoUrl -TimeoutSec 1 -ErrorAction Stop
      $curUrl = $inf.tunnelInfo.publicUrl
      if ($curUrl -and $curUrl -ne $lastShownPublicUrl) {
        $lastShownPublicUrl = $curUrl
        $newBro = "$curUrl$pathSuffix"
        try { Set-Clipboard -Value $newBro } catch {}
        Write-Host "[UI ROUTE SWITCH] $($inf.tunnelInfo.routeLabel) -> $newBro"`
          -ForegroundColor Green
      }
    } catch {}
  }
} finally {
  Write-Host "`nShutting down Node.js Server and SSH Tunnel..." `
    -ForegroundColor Yellow
  if ($nodeProc -and !$nodeProc.HasExited) {
    Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue
  }
}
