# High-Latency Network & Tunnel Reference

## 1. Real-World 2-PC Benchmark Results (~6,500 km Long-Distance Link)

Measured between **PC 1 (Host, Asia-Pacific edge)** and **PC 2 (Remote Guest)**
using the built-in automated benchmark (`/autotest`):

| Stage / Metric | `localhost.run` | `pinggy.io` (`ap`) | Improvement |
| :--- | :--- | :--- | :--- |
| **1. Peer WSS RTT (Med / Min)** | `689ms / 664ms` | **`217ms / 209ms`** | `3.2x` lower RTT |
| **3. 60Hz Input Stream (3s)** | `180/180` (292ms) | **`180/180` (103ms)** | `0%` loss |
| **4. 16 KB Chunked Transfer** | `2,623 ms` | **`425 ms`** | `6.1x` faster |
| **4. 64 KB Chunked Transfer** | `8,516 ms` | **`437 ms`** | `19.5x` faster |
| **5. 256 KB ROM Transfer** | `45,411 ms` | **`616 ms`** | **`73x` faster** |
| **6. Post-Transfer Cooldown** | `634 ms` | **`219 ms`** | Zero bufferbloat |

## 2. WebRTC UDP vs Strict NAT / DPI / Browser Proxies

- **Browser Proxy UDP Restrictions:**
  - Privacy/proxy extensions can set `webRTCIPHandlingPolicy` to
    `disable_non_proxied_udp`, causing Chrome to gather `0` local UDP ICE
    candidates (`LocalCand=[]`).
- **UDP Port Filtering / DPI Interference:**
  - Some ISP DPI filters and UDP anti-censorship tools intercept or throttle
    high-rate raw UDP or specific STUN ports (such as `3478`), while allowing
    ports `443` and `19302`/`19305`.
- **Reliable Fallback (Dual-Stream WSS Relay over Port 443):**
  - Because `pinggy.io` (`ap` / `eu` regions) achieves `~210-220 ms` RTT and
    `>300 KB/s` throughput over standard TLS port 443, gameplay runs smoothly
    over WSS Relay even when direct WebRTC UDP is blocked.

## 3. Critical Protocol Rules (Do Not Regress)

1. **RLE Tail-Trimming on 60Hz Input Packets:**
   - Each `netplay_input` packet carries a 32-frame sliding history window
     (`startFrame .. startFrame - 31`) for packet-loss resilience.
   - Unchanging tail bytes are run-length trimmed (`inputs` + `tailCount`),
     shrinking steady-state packets from ~190 bytes to ~85 bytes so full 60Hz
     streaming never triggers SSH tunnel congestion.
2. **Dual-WebSocket Striping (`ws + wsAux`) & Deduplication:**
   - Clients open a primary WebSocket (`/ws`) and an auxiliary WebSocket
     (`/ws?aux=1` bound via `bind_aux`).
   - Both client and server stripe `netplay_input` packets across `ws` and
     `wsAux` and deduplicate by `sessionId:startFrame:input0:hashFrame` so a
     TCP retransmission stall on one stream is bypassed by the parallel stream.
3. **Stream `16 KB` Chunks Continuously (No Per-Chunk Stop-and-Wait ACKs):**
   - Large transfers (`rom_chunk_data` / `diag_xfer_chunk`) must stream `16 KB`
     chunks continuously and verify once at the end with CRC32 (`sync_ack`).
4. **Strictly FIFO Relay Server (`server/room_manager.mjs`):**
   - The relay server must forward all room messages synchronously in exact
     FIFO arrival order without artificial queuing or reordering.
