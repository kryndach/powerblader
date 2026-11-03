param(
  [ValidateSet("localhost.run", "pinggy")]
  [string]$Tunnel = "localhost.run",
  [ValidateSet("autotest", "nettest", "game")]
  [string]$Mode = "autotest",
  [int]$Port = 8080
)

$ErrorActionPreference = "Continue"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

Write-Host ""
Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host "   NES ONLINE & 2-PC AUTO-BENCHMARK ONE-CLICK LAUNCHER" -ForegroundColor Cyan
Write-Host "====================================================================" -ForegroundColor Cyan

# 1. Stop any existing process bound to $Port
$existingConns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existingConns) {
  foreach ($conn in $existingConns) {
    $pidToKill = $conn.OwningProcess
    if ($pidToKill -and $pidToKill -gt 4) {
      Write-Host "[1/4] Stopping previous server on port $Port (PID $pidToKill)..." -ForegroundColor Yellow
      Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 600
}

# 2. Start Node.js Relay Server
Write-Host "[2/4] Starting local Node.js Relay & Auto-Test Server on port $Port..." -ForegroundColor Green
$nodeOut = Join-Path $RootDir "logs\server_stdout.log"
$nodeErr = Join-Path $RootDir "logs\server_stderr.log"
if (!(Test-Path (Join-Path $RootDir "logs"))) {
  New-Item -ItemType Directory -Path (Join-Path $RootDir "logs") | Out-Null
}

$nodeProc = Start-Process -FilePath "node" `
  -ArgumentList "server/relay_server.mjs" `
  -WorkingDirectory $RootDir `
  -RedirectStandardOutput $nodeOut `
  -RedirectStandardError $nodeErr `
  -NoNewWindow `
  -PassThru

# Wait for /api/health
$serverReady = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $resp = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 1 -ErrorAction Stop
    if ($resp.ok) {
      $serverReady = $true
      break
    }
  } catch {}
}

if (-not $serverReady) {
  Write-Host "[ERROR] Node.js server failed to start on port $Port. Check logs/server_stderr.log." -ForegroundColor Red
  if ($nodeProc -and !$nodeProc.HasExited) { Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue }
  exit 1
}
Write-Host "      Server is ONLINE at http://localhost:$Port" -ForegroundColor Green

# 3. Start SSH Tunnel and capture public URL automatically
$sshOut = Join-Path $RootDir "logs\tunnel_stdout.log"
$sshErr = Join-Path $RootDir "logs\tunnel_stderr.log"
Remove-Item $sshOut -Force -ErrorAction SilentlyContinue
Remove-Item $sshErr -Force -ErrorAction SilentlyContinue

if ($Tunnel -eq "pinggy") {
  Write-Host "[3/4] Starting low-latency SSH tunnel via Pinggy (a.pinggy.io)..." -ForegroundColor Green
  $sshArgs = "-T -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o IPQoS=lowdelay -R0:127.0.0.1:$Port a.pinggy.io"
} else {
  Write-Host "[3/4] Starting SSH tunnel via localhost.run (with -T -o IPQoS=lowdelay)..." -ForegroundColor Green
  $sshArgs = "-T -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o IPQoS=lowdelay -R 80:127.0.0.1:$Port nokey@localhost.run"
}

$sshProc = Start-Process -FilePath "ssh.exe" `
  -ArgumentList $sshArgs `
  -WorkingDirectory $RootDir `
  -RedirectStandardOutput $sshOut `
  -RedirectStandardError $sshErr `
  -NoNewWindow `
  -PassThru

$publicBaseUrl = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 350
  $combined = ""
  if (Test-Path $sshOut) { $combined += (Get-Content $sshOut -Raw -ErrorAction SilentlyContinue) + "`n" }
  if (Test-Path $sshErr) { $combined += (Get-Content $sshErr -Raw -ErrorAction SilentlyContinue) + "`n" }

  if ($combined -match "(https://[a-zA-Z0-9\-\.]+\.(lhr\.life|pinggy\.link|pinggy\.online))") {
    $publicBaseUrl = $Matches[1]
    break
  }
}

$pathSuffix = "/autotest"
if ($Mode -eq "nettest") { $pathSuffix = "/nettest?room=NOVA" }
if ($Mode -eq "game") { $pathSuffix = "/?room=NOVA" }

$localUrl = "http://localhost:$Port$pathSuffix"

if ($publicBaseUrl) {
  $broUrl = "$publicBaseUrl$pathSuffix"
  try { Set-Clipboard -Value $broUrl } catch {}

  Write-Host ""
  Write-Host "====================================================================" -ForegroundColor Green
  Write-Host "   READY! NO ROOM CODE NEEDED -- JUST OPEN THESE LINKS:" -ForegroundColor Green
  Write-Host "====================================================================" -ForegroundColor Green
  Write-Host ""
  Write-Host "  1. SEND THIS LINK TO BROTHER (Already copied to your Clipboard!):" -ForegroundColor Yellow
  Write-Host "     $broUrl" -ForegroundColor White
  Write-Host ""
  Write-Host "  2. YOUR LOCAL LINK (Opening in your browser now...):" -ForegroundColor Cyan
  Write-Host "     $localUrl" -ForegroundColor White
  Write-Host ""
  Write-Host "  Other Direct Links (Zero Room Setup):" -ForegroundColor DarkGray
  Write-Host "     Auto-Tester:  $publicBaseUrl/autotest" -ForegroundColor Gray
  Write-Host "     Workbench:    $publicBaseUrl/nettest?room=NOVA" -ForegroundColor Gray
  Write-Host "     NES Console:  $publicBaseUrl/?room=NOVA" -ForegroundColor Gray
  Write-Host "====================================================================" -ForegroundColor Green
} else {
  Write-Host "[WARN] Could not auto-parse tunnel URL yet. Check logs/tunnel_stdout.log." -ForegroundColor Yellow
  Write-Host "Local URL: $localUrl" -ForegroundColor Cyan
}

# 4. Open local browser automatically
Write-Host "[4/4] Opening $localUrl in your default browser..." -ForegroundColor Green
Start-Process $localUrl

$reportFile = Join-Path $RootDir "logs\autotest_latest.txt"
$lastReportWrite = if (Test-Path $reportFile) { (Get-Item $reportFile).LastWriteTime } else { [datetime]::MinValue }

Write-Host ""
Write-Host "Watching for 2-PC Auto-Test results (saves automatically to logs/autotest_latest.txt)..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C at any time to stop both the Server and SSH Tunnel." -ForegroundColor DarkGray
Write-Host ""

try {
  while ($true) {
    Start-Sleep -Seconds 1
    if ($nodeProc.HasExited) {
      Write-Host "[ERROR] Node.js server exited unexpectedly." -ForegroundColor Red
      break
    }
    if ($sshProc.HasExited) {
      Write-Host "[WARN] SSH tunnel closed -- restarting SSH tunnel..." -ForegroundColor Yellow
      $sshProc = Start-Process -FilePath "ssh.exe" `
        -ArgumentList $sshArgs `
        -WorkingDirectory $RootDir `
        -RedirectStandardOutput $sshOut `
        -RedirectStandardError $sshErr `
        -NoNewWindow `
        -PassThru
    }
    if (Test-Path $reportFile) {
      $curWrite = (Get-Item $reportFile).LastWriteTime
      if ($curWrite -gt $lastReportWrite) {
        $lastReportWrite = $curWrite
        $content = Get-Content $reportFile -Raw -ErrorAction SilentlyContinue
        if ($content -match "Stage Status:\s+COMPLETE") {
          Write-Host "====================================================================" -ForegroundColor Green
          Write-Host " [SAVED] 2-PC Auto-Benchmark COMPLETE! Saved to logs/autotest_latest.txt" -ForegroundColor Green
          Write-Host " You can now tell the AI 'autotest is done' (or paste the report)!" -ForegroundColor Yellow
          Write-Host "====================================================================" -ForegroundColor Green
        }
      }
    }
  }
} finally {
  Write-Host "`nShutting down Node.js Server and SSH Tunnel..." -ForegroundColor Yellow
  if ($sshProc -and !$sshProc.HasExited) { Stop-Process -Id $sshProc.Id -Force -ErrorAction SilentlyContinue }
  if ($nodeProc -and !$nodeProc.HasExited) { Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue }
}
