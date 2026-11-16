param(
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

$sep = "================================================================"
Write-Host ""
Write-Host $sep -ForegroundColor Cyan
Write-Host "   NES ONLINE & 2-PC AUTO-BENCHMARK ONE-CLICK LAUNCHER" `
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

# 2. Start Node.js Relay Server
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
    if ($resp.ok) {
      $serverReady = $true
      break
    }
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

# 3. Start SSH Tunnel and capture public URL automatically
$sshOut = Join-Path $logsDir "tunnel_stdout.log"
$sshErr = Join-Path $logsDir "tunnel_stderr.log"
Remove-Item $sshOut -Force -ErrorAction SilentlyContinue
Remove-Item $sshErr -Force -ErrorAction SilentlyContinue

$activeEdgeLabel = $Region
if ($Tunnel -eq "pinggy") {
  $tunnelKey = Join-Path $logsDir "pinggy_ed25519"
  if (!(Test-Path $tunnelKey)) {
    Write-Host "      Generating local SSH key for Pinggy tunnel..." `
      -ForegroundColor DarkGray
    cmd.exe /c "ssh-keygen -t ed25519 -f `"$tunnelKey`" -q -N `"`"" | Out-Null
  }
  $pinggyHost = "ap.a.pinggy.io"
  if ($Region -eq "ap") { $pinggyHost = "lin.ap.1.a.pinggy.click" }
  if ($Region -eq "eu") { $pinggyHost = "eu.a.pinggy.io" }
  if ($Region -eq "us") { $pinggyHost = "us.a.pinggy.io" }
  if ($TunnelHost -ne "") { $pinggyHost = $TunnelHost }
  $activeEdgeLabel = "$Region [$pinggyHost]"
  Write-Host "[3/4] Starting Pinggy SSH ($pinggyHost, prefer=$PreferDomain)" `
    -ForegroundColor Green
  $sshOpts = "-T -p 443 -i `"$tunnelKey`" -o StrictHostKeyChecking=no " +
    "-o BatchMode=yes -o ServerAliveInterval=15 -o IPQoS=lowdelay"
  $sshArgs = "$sshOpts -R0:127.0.0.1:$Port $pinggyHost"
} else {
  $activeEdgeLabel = "ssh [localhost.run]"
  Write-Host "[3/4] Starting SSH tunnel via localhost.run..." `
    -ForegroundColor Green
  $sshOpts = "-T -o StrictHostKeyChecking=no -o ServerAliveInterval=15 " +
    "-o IPQoS=lowdelay"
  $sshArgs = "$sshOpts -R 80:127.0.0.1:$Port nokey@localhost.run"
}

$sshProc = Start-Process -FilePath "ssh.exe" `
  -ArgumentList $sshArgs `
  -WorkingDirectory $RootDir `
  -RedirectStandardOutput $sshOut `
  -RedirectStandardError $sshErr `
  -NoNewWindow `
  -PassThru

$publicBaseUrl = $null
$altBaseUrl = $null
$urlRegex = "(https://[a-zA-Z0-9\-\.]+\." +
  "(lhr\.life|pinggy-free\.link|free\.pinggy\.net|pinggy\.link|pinggy\.online))"
$waitedSecondUrl = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 350
  $combined = ""
  if (Test-Path $sshOut) {
    $combined += (Get-Content $sshOut -Raw -ErrorAction SilentlyContinue) + "`n"
  }
  if (Test-Path $sshErr) {
    $combined += (Get-Content $sshErr -Raw -ErrorAction SilentlyContinue) + "`n"
  }
  $found = @([regex]::Matches($combined, $urlRegex) |
    ForEach-Object { $_.Value } | Select-Object -Unique)
  if ($found.Count -ge 1) {
    if ($Tunnel -eq "pinggy" -and $found.Count -lt 2 -and !$waitedSecondUrl) {
      $waitedSecondUrl = $true
      Start-Sleep -Milliseconds 450
      continue
    }
    $publicBaseUrl = $found[0]
    if ($PreferDomain -ne "any") {
      foreach ($u in $found) {
        if ($u -like "*$PreferDomain*") { $publicBaseUrl = $u; break }
      }
    }
    foreach ($u in $found) {
      if ($u -ne $publicBaseUrl) { $altBaseUrl = $u; break }
    }
    break
  }
}

$pathSuffix = "/autotest"
if ($Mode -eq "nettest") { $pathSuffix = "/nettest?room=NOVA" }
if ($Mode -eq "game") { $pathSuffix = "/?room=NOVA" }

$localUrl = "http://localhost:$Port$pathSuffix"
$infoUrl = "http://localhost:$Port/api/tunnel-info"

try {
  $tunnelInfoBody = @{
    tunnel = $Tunnel
    region = $activeEdgeLabel
    publicUrl = $publicBaseUrl
  } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri $infoUrl -Method Post -Body $tunnelInfoBody `
    -ContentType "application/json" -TimeoutSec 2 `
    -ErrorAction SilentlyContinue | Out-Null
} catch {}

if ($publicBaseUrl) {
  $broUrl = "$publicBaseUrl$pathSuffix"
  try { Set-Clipboard -Value $broUrl } catch {}

  Write-Host ""
  Write-Host $sep -ForegroundColor Green
  Write-Host "   READY! NO ROOM CODE NEEDED -- JUST OPEN THESE LINKS:" `
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
  Write-Host "  Other Direct Links ($activeEdgeLabel):" `
    -ForegroundColor DarkGray
  Write-Host "     Auto-Tester:  $publicBaseUrl/autotest?gameRoom=NOVA" `
    -ForegroundColor Gray
  Write-Host "     Workbench:    $publicBaseUrl/nettest?room=NOVA" `
    -ForegroundColor Gray
  Write-Host $sep -ForegroundColor Green
} else {
  Write-Host "[WARN] Could not parse tunnel URL yet. Check logs." `
    -ForegroundColor Yellow
  Write-Host "Local URL: $localUrl" -ForegroundColor Cyan
}

# 4. Open local browser automatically
Write-Host "[4/4] Opening $localUrl in your default browser..." `
  -ForegroundColor Green
Start-Process $localUrl

$reportFile = Join-Path $logsDir "autotest_latest.txt"
$lastReportWrite = if (Test-Path $reportFile) {
  (Get-Item $reportFile).LastWriteTime
} else {
  [datetime]::MinValue
}

Write-Host ""
Write-Host "Watching for 2-PC Auto-Test results (logs/autotest_latest.txt)..." `
  -ForegroundColor Cyan
Write-Host "Press Ctrl+C at any time to stop the Server and SSH Tunnel." `
  -ForegroundColor DarkGray
Write-Host ""

try {
  while ($true) {
    Start-Sleep -Seconds 1
    if ($nodeProc.HasExited) {
      Write-Host "[ERROR] Node.js server exited unexpectedly." `
        -ForegroundColor Red
      break
    }
    if ($sshProc.HasExited) {
      Write-Host "[WARN] SSH tunnel closed -- restarting..." `
        -ForegroundColor Yellow
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
          Write-Host $sep -ForegroundColor Green
          Write-Host " [SAVED] 2-PC Auto-Benchmark COMPLETE!" `
            -ForegroundColor Green
          Write-Host " Saved to logs/autotest_latest.txt" `
            -ForegroundColor Yellow
          Write-Host $sep -ForegroundColor Green
        }
      }
    }
  }
} finally {
  Write-Host "`nShutting down Node.js Server and SSH Tunnel..." `
    -ForegroundColor Yellow
  if ($sshProc -and !$sshProc.HasExited) {
    Stop-Process -Id $sshProc.Id -Force -ErrorAction SilentlyContinue
  }
  if ($nodeProc -and !$nodeProc.HasExited) {
    Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue
  }
}
