# Singapore ↔ Russia Network & Tunnel Reference

## 1. Real-World 2-PC Benchmark Results (Singapore ↔ Omsk, Russia)

Tested between **PC 1 (Singapore)** and **PC 2 (Isilkul, Omsk Oblast, Russia)**
using the built-in 6-stage automated benchmark (`/autotest`):

| Stage / Metric | `localhost.run` | `pinggy.io` (`ap`) | Improvement |
| :--- | :--- | :--- | :--- |
| **1. Peer WSS RTT (Med / Min)** | `689ms / 664ms` | **`217ms / 209ms`** | `3.2x` lower RTT |
| **3. 60Hz NES Input Stream (3s)** | `180/180` (292ms) | **`180/180` (103ms)** | `0%` loss |
| **4. 16 KB Chunked Transfer** | `2,623 ms` | **`425 ms`** | `6.1x` faster |
| **4. 64 KB Chunked Transfer** | `8,516 ms` | **`437 ms`** | `19.5x` faster |
| **5. 256 KB ROM Transfer** | `45,411 ms` | **`616 ms`** | **`73x` faster** |
| **6. Post-Transfer Cooldown** | `634 ms` | **`219 ms`** | Zero bufferbloat |

## 2. WebRTC UDP vs `Flowseal/zapret-discord-youtube`

- **Browser Extension UDP Block on PC 2:**
  - On PC 2, a Chrome proxy/VPN extension sets `webRTCIPHandlingPolicy` to
    `disable_non_proxied_udp`, causing Chrome to gather `0` local UDP ICE
    candidates (`LocalCand=[]`).
- **`zapret` UDP Port Whitelist:**
  - `zapret-discord-youtube` (`winws.exe`) intercepts UDP ports `443`,
    `19294-19344`, and `50000-50100`. Google STUN ports `19302`/`19305` and
    `443` fall inside this range, whereas standard port `3478` does not.
- **Primary Transport (Dual-Stream WSS Relay over Port 443):**
  - Because `pinggy.io` (`ap` region) achieves `209-217 ms` RTT and `>300 KB/s`
    throughput over standard TLS port 443, gameplay runs smoothly over WSS
    Relay even when WebRTC UDP is blocked.

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
