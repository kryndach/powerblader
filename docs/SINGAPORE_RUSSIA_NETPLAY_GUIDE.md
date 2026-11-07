# Singapore <-> Russia Low-Ping Netplay & Tunnel Engineering Guide

> Self-contained context document for AI coding sessions (e.g., optimizing
> **Factorio** or other multiplayer games between Singapore and Russia).

---

## 1. Physical Network Topology & Environment

| Peer | Location | OS / Shell | Network & DPI Constraints |
| :--- | :--- | :--- | :--- |
| **PC 1 (Host)** | **Singapore** | Windows, PowerShell 5.1 | Behind residential NAT/CGNAT (no router port forwarding). |
| **PC 2 (Client)** | **Isilkul, Omsk Oblast, Russia** | Windows | Russian ISP DPI (`TSPU`) + running `Flowseal/zapret-discord-youtube` (`winws.exe`) + browser proxy extension. |

### Key Routing & Latency Facts
- **Physical Distance:** ~6,500 km (Singapore <-> Western Siberia).
- **Optimal Practical RTT:** **`209 ms - 217 ms`** (~105 ms one-way) when
  routed via a **Singapore / Asia-Pacific (`ap`)** ingress edge.
- **Bad Relay Penalty:** Default US or Western European relays (e.g.
  `localhost.run`, default Steam SDR fallback, or US tunnels) inflate RTT to
  **`664 ms - 689 ms`** and suffer catastrophic TCP/UDP bufferbloat.

---

## 2. Why Direct P2P / Raw UDP Fails or Lags on PC 2 (Russia)

Through extensive diagnostics between Singapore and Isilkul, we identified three
distinct mechanisms that break or degrade standard game networking:

1. **Russian ISP Deep Packet Inspection (`TSPU`) on Raw UDP:**
   - Unidentified high-rate UDP streams (like game state packets at 60Hz, custom
     UDP ports like Factorio's `34197`, WireGuard, or non-standard STUN `3478`)
     are frequently throttled, rate-limited, or silently dropped after burst
     transfers (such as map downloads).
2. **`zapret-discord-youtube` (`winws.exe`) Packet Interception on PC 2:**
   - PC 2 runs `zapret` (`winws.exe`) to bypass Discord/YouTube blocks.
   - `winws.exe` intercepts TCP ports `80, 443` and UDP ports `443,
     19294-19344, 50000-50100`, injecting fake/desync packets.
3. **Browser / Proxy UDP Blocking on PC 2:**
   - Proxy extensions on PC 2 enforce `disable_non_proxied_udp`, preventing
     direct UDP ICE candidate gathering (`0` local UDP candidates).
4. **Why Port 443 TLS / WSS to a Singapore Edge Succeeds:**
   - Standard TLS/HTTPS/WSS traffic on **TCP port 443** terminated at a
     **Singapore edge (`ap.a.pinggy.io`)** passes cleanly through Russian ISP
     DPI without throttling, requires zero port-forwarding on PC 1, and
     delivers **`209-217 ms` RTT** with **`>300 KB/s`** clean throughput.

---

## 3. Empirical 2-PC Benchmark (`Singapore <-> Omsk, Russia`)

Measured live between PC 1 and PC 2 using our 6-stage automated network suite:

| Benchmark Stage | `localhost.run` (Default) | `pinggy.io` (`ap` Edge) | Improvement |
| :--- | :--- | :--- | :--- |
| **1. Peer RTT (Median / Min)** | `689 ms / 664 ms` | **`217 ms / 209 ms`** | **`3.2x` lower ping** |
| **2. 60Hz Input Stream (3s)** | `180/180` (`292 ms` 1-way) | **`180/180` (`103 ms` 1-way)** | **`0%` packet loss** |
| **3. 16 KB Burst Transfer** | `2,623 ms` | **`425 ms`** | `6.1x` faster |
| **4. 64 KB Burst Transfer** | `8,516 ms` | **`437 ms`** | `19.5x` faster |
| **5. 256 KB Payload Transfer** | `45,411 ms` (`5.6 KB/s`) | **`616 ms` (`415 KB/s`)** | **`73x` faster** |
| **6. Post-Transfer Cooldown RTT** | `634 ms` | **`219 ms`** | **Zero bufferbloat** |

### Exact Pinggy AP Tunnel Command Used on PC 1 (Singapore)
```powershell
ssh.exe -p 443 -R0:localhost:8080 `
  -o StrictHostKeyChecking=no `
  -o UserKnownHostsFile=/dev/null `
  -o ServerAliveInterval=15 `
  -o ServerAliveCountMax=3 `
  -o ExitOnForwardFailure=yes `
  a.pinggy.io
```

---

## 4. What We Implemented in Our Netcode to Eliminate Lag & Jitter

Even with a `215 ms` RTT tunnel, TCP-over-SSH tunnels introduce **packet
clumping** (2-5 frames arriving in the same millisecond after a micro-stall). We
solved this with six engineering techniques:

### 4.1. Dual-WebSocket Striping (`ws + wsAux`) & Receiver Deduplication
- **Problem:** Over TCP, a single lost packet triggers Head-of-Line (HoL)
  blocking, stalling delivery of subsequent 60Hz packets for `1 RTT` (`~215ms`).
- **Solution:** Each client opens **two parallel WebSocket connections** (`ws`
  and `wsAux`) over the tunnel. High-frequency 60Hz packets are striped/mirrored
  across both sockets and deduplicated at the receiver by packet key
  (`sessionId:frame`). When one TCP stream stalls, the second stream delivers
  the frame on time.

### 4.2. Sliding Redundancy Window + RLE Payload Compression
- **Problem:** Waiting for retransmission of a dropped 60Hz input packet adds
  `215 ms` of lag; sending bloated packets saturates the SSH tunnel.
- **Solution:** Every 60Hz packet carries a sliding 32-frame history window so
  any single lost packet is reconstructed from the next packet (`16 ms` later).
  Unchanged tail inputs are Run-Length Encoded (RLE), cutting packet size by
  `>50%` (`~85 bytes/pkt`).

### 4.3. Clump-Aware Clock-Rift Pacing (`rxClumpFrames`)
- **Problem:** SSH tunnels deliver 60Hz packets in bursts (`2-5` packets at
  once). Naive lockstep/rollback engines mistake burst arrival for clock drift
  and constantly speed up / slow down the game.
- **Solution:** We measure the inter-arrival burst size (`rxClumpFrames` via
  EMA) and subtract remote input delay when computing clock rift. Game tick
  duration scales smoothly by at most `+/-3%` (`Sub-Frame Fractional
  Time-Sync`), keeping both PCs locked within `0.25` frames with zero stutter.

### 4.4. Asymmetric Independent Input Delay
- **Problem:** PC 1 and PC 2 may want different local responsiveness vs.
  rollback smoothness.
- **Solution:** Each peer independently chooses `0..5` frames of local input
  delay (or `Auto` based on live `RTT + Jitter + Clump`), advertising its delay
  in every packet header so timelines never desync.

### 4.5. Pipelined `16 KB` Streaming (No Stop-and-Wait ACKs)
- **Problem:** Waiting for an ACK after each chunk over a `215 ms` link caps
  transfer speed at `16 KB / 0.215s = 74 KB/s`.
- **Solution:** Stream `16 KB` chunks continuously back-to-back without
  per-chunk ACKs, and verify once at the end with a `CRC32` hash + single ACK.

### 4.6. Anti-Throttle 60Hz Worker Timer & DRC Audio Crossfading
- A dedicated Web Worker (`4 ms` interval) drives the 60Hz network loop even
  when a player Alt-Tabs, preventing lockstep/rollback starvation.
- A 48 kHz Dynamic Rate Control (DRC) audio resampler (`0.95x..1.05x`) with a
  `1 ms` post-rollback linear crossfade prevents audio clicks during rollbacks.

---

## 5. How to Apply These Findings to Factorio (Singapore <-> Russia)

**Factorio** runs a deterministic **60 UPS lockstep engine** over **UDP port
`34197`** (or Steam Datagram Relay). When playing between Singapore and Omsk:

### Why Factorio Struggles by Default
1. **Direct UDP `34197` Blocked/Throttled:** PC 1 has no port forwarding (CGNAT)
   and Russian ISP DPI throttles sustained high-rate UDP bursts (especially
   during initial `20-80 MB` map download or heavy combat).
2. **Suboptimal Steam SDR Relay Selection:** Steam P2P often routes Singapore
   <-> Siberia through European (Frankfurt/Stockholm) or US relays (`350-500ms`)
   or triggers `zapret` UDP port conflicts on PC 2.
3. **Burst Drops on Map Catch-up:** Factorio's default `maximum_segment_size`
   sends large UDP bursts that trip ISP DPI policers in Russia, causing the
   *"Server is not responding"* bar.

### Recommended Factorio Architecture & Fixes

#### Strategy A: Local UDP-to-Dual-WSS Bridge over Pinggy AP (`Port 443`)
Reuse our proven `209 ms` Pinggy AP (`ap.a.pinggy.io`) port-443 path for
Factorio without needing a VPN or router port-forwarding:
1. **On PC 1 (Singapore):**
   - Factorio hosts on `127.0.0.1:34197` (UDP).
   - A lightweight Node.js bridge listens on `localhost:8080` (Dual-WSS) and
     forwards packets to/from UDP `127.0.0.1:34197`, exposed via `pinggy.io`
     (`ap` region, port 443).
2. **On PC 2 (Russia):**
   - A small local Node.js client connects to the Pinggy `wss://...` URL using
     **Dual-WSS striping (`ws + wsAux`)** and exposes a local UDP socket at
     `127.0.0.1:34197`.
   - Brother connects Factorio via **Multiplayer -> Connect to address ->
     `127.0.0.1:34197`**.
3. **Why this works:** Factorio sees a local UDP socket; Russian ISP DPI only
   sees standard port-443 HTTPS/WSS traffic to Singapore; Dual-WSS striping
   prevents TCP HoL stalls from causing Factorio tick pauses.

#### Strategy B: Steam Launch Options (`Steam Networking` Pinning)
If using Steam invites instead of a custom tunnel, force Valve SDR to pin the
**Singapore (`sgp`)** or **Hong Kong (`hkg`)** relay cluster in Factorio's Steam
Launch Options on both PCs so Steam never routes via Europe/US:
- Test relay pings via Steam console (`net_status`) and set `minimum_latency`.

#### Strategy C: Factorio `server-settings.json` & `config.ini` Tuning
Apply these settings on PC 1 (Host) to prevent Russian DPI burst-drops and
smooth out 60 UPS lockstep over `~215 ms` RTT:
- **`minimum_latency_in_ticks`:** Set to **`15` or `16`** (`250-266 ms` at 60
  UPS). Covers `215 ms` RTT + `35 ms` jitter margin so neither PC stalls waiting
  for tick confirmation.
- **`maximum_segment_size`:** Lower from `100` to **`40`** (in `config.ini` /
  `server-settings.json`) to avoid large UDP packet bursts that trigger Russian
  ISP rate-limiters during map downloads.
- **`max_upload_in_kilobytes_per_second`:** Cap at **`300` - `500` KB/s** so map
  transfer doesn't saturate the tunnel and starve live heartbeat packets.
- **`non_blocking_saving`:** Enable (`true` on Linux/macOS or fast autosave
  tuning on Windows) so autosaves don't pause the tunnel stream.
