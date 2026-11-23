# High-Latency Low-Ping Netplay & Tunnel Engineering Guide

> Engineering reference for running deterministic 60Hz multiplayer and tunnel
> relays across long-distance (~220 ms RTT), CGNAT, and DPI-filtered networks.

---

## 1. Network Topology & Constraints

| Peer | Role | Environment | Network Constraints |
| :--- | :--- | :--- | :--- |
| **PC 1 (Host)** | Relay / P2P Host | Windows / Node.js | Behind residential NAT/CGNAT (no router port forwarding). |
| **PC 2 (Guest)** | Remote Client | Windows / Browser | Strict ISP DPI / UDP throttling or browser proxy extensions. |

### Key Routing & Latency Findings
- **Physical Distance:** ~6,500 km inter-regional link.
- **Optimal Practical RTT:** **`209 ms - 217 ms`** (~105 ms one-way) when
  routed via an optimal regional (`ap` / `eu`) ingress edge.
- **Suboptimal Relay Penalty:** Distant default relays (e.g. `localhost.run`
  or US detours) inflate RTT to **`664 ms - 689 ms`** and suffer severe
  TCP/UDP bufferbloat.

---

## 2. Why Direct P2P / Raw UDP Fails or Lags on Filtered Networks

1. **ISP Deep Packet Inspection (DPI) on Raw UDP:**
   - Unidentified high-rate UDP streams (60Hz game packets or non-standard STUN
     ports like `3478`) are frequently throttled or silently dropped after
     burst transfers.
2. **Local Firewall / Proxy UDP Blocking:**
   - Proxy extensions can enforce `disable_non_proxied_udp`, preventing direct
     UDP ICE candidate gathering (`0` local UDP candidates).
3. **Why Port 443 TLS / WSS to a Regional Edge Succeeds:**
   - Standard TLS/HTTPS/WSS traffic on **TCP port 443** passes cleanly through
     strict firewalls and ISP DPI without port forwarding on the Host, yielding
     **`209-217 ms` RTT** with **`>300 KB/s`** clean throughput.

---

## 3. Empirical 2-PC Benchmark (~215 ms Link)

Measured live between two remote PCs using the built-in automated suite:

| Benchmark Stage | `localhost.run` (Default) | `pinggy.io` (`ap` Edge) | Improvement |
| :--- | :--- | :--- | :--- |
| **1. Peer RTT (Median / Min)** | `689 ms / 664 ms` | **`217 ms / 209 ms`** | **`3.2x` lower ping** |
| **2. 60Hz Input Stream (3s)** | `180/180` (`292 ms` 1-way) | **`180/180` (`103 ms` 1-way)** | **`0%` packet loss** |
| **3. 16 KB Burst Transfer** | `2,623 ms` | **`425 ms`** | `6.1x` faster |
| **4. 64 KB Burst Transfer** | `8,516 ms` | **`437 ms`** | `19.5x` faster |
| **5. 256 KB Payload Transfer** | `45,411 ms` (`5.6 KB/s`) | **`616 ms` (`415 KB/s`)** | **`73x` faster** |
| **6. Post-Transfer Cooldown RTT** | `634 ms` | **`219 ms`** | **Zero bufferbloat** |

### Example Pinggy AP Tunnel Command (Host)
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

## 4. Netcode Techniques Used to Eliminate Lag & Jitter

Even on a `215 ms` RTT link, TCP-over-SSH tunnels introduce **packet clumping**
(2-5 frames arriving together after a micro-stall). Six techniques solve this:

### 4.1. Dual-WebSocket Striping (`ws + wsAux`) & Receiver Deduplication
- **Problem:** Over TCP, a single lost packet triggers Head-of-Line (HoL)
  blocking, stalling subsequent 60Hz packets for `1 RTT` (`~215ms`).
- **Solution:** Each client opens **two parallel WebSocket connections** (`ws`
  and `wsAux`) over the tunnel. High-frequency 60Hz packets are striped across
  both sockets and deduplicated at the receiver by packet key
  (`sessionId:frame`). When one stream stalls, the parallel stream delivers
  the frame on time.

### 4.2. Sliding Redundancy Window + RLE Payload Compression
- **Problem:** Retransmitting a lost 60Hz packet adds `215 ms` of latency;
  bloated packets saturate the tunnel.
- **Solution:** Every 60Hz packet carries a sliding 32-frame history window so
  any single lost packet is reconstructed from the next packet (`16 ms` later).
  Unchanged tail inputs are Run-Length Encoded (RLE), cutting packet size by
  `>50%` (`~85 bytes/pkt`).

### 4.3. Clump-Aware Clock-Rift Pacing (`rxClumpFrames`)
- **Problem:** Tunnels deliver 60Hz packets in bursts (`2-5` packets at once).
  Naive engines mistake burst arrival for clock drift and hitch continuously.
- **Solution:** Measure inter-arrival burst size (`rxClumpFrames` via EMA) and
  subtract remote input delay when computing clock rift. Game tick duration
  scales smoothly by at most `+/-2.5%` (`Sub-Frame Fractional Time-Sync`),
  keeping both PCs locked within `0.25` frames without stutter.

### 4.4. Asymmetric Independent Input Delay
- Each peer independently selects `0..5` frames of local input delay (or `Auto`
  based on live `RTT + Jitter + Clump`), advertising its delay in every packet
  header so timelines stay deterministic.

### 4.5. Pipelined `16 KB` Streaming & 8x Striped HTTP Range Transfers
- Stream chunks back-to-back without per-chunk stop-and-wait ACKs, or transfer
  ROMs via 8 parallel HTTP `Range` requests with gzip compression and CRC32
  client-side caching (`0 KB` wire transfer on cache hit).

### 4.6. Anti-Throttle 60Hz Worker Timer, Shadow Rollback & DRC Audio
- A dedicated Web Worker drives the 60Hz loop even if a tab loses focus.
- Arcade cores offload rollback replay to a secondary Shadow Worker thread so
  main-thread `rAF` stays locked at 60 FPS with `0` frame freezes.
- A 48 kHz Dynamic Rate Control (DRC) audio resampler (`0.95x..1.05x`) with a
  `1 ms` post-rollback linear crossfade prevents clicks during rollbacks.
