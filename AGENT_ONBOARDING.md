# AI Agent Onboarding & Project Context (`NES_Online`)

> **Purpose:** Read this file first when starting a new session. It contains the complete architectural context, real-world Singapore ↔ Russia network findings, benchmark results, file map, and operational rules established across previous sessions.

---

## 1. User & Environment Setup

- **Player 1 (Host / User):** Located in **Singapore** (`PC 1`, Windows 10/11, PowerShell 5.1). Runs the local Node.js server on `http://localhost:8080` and exposes it via an SSH reverse tunnel.
- **Player 2 (Remote / Brother):** Located in **Isilkul, Omsk Oblast, Russia** (`PC 2`, Western Siberia near the Kazakhstan border, Windows). Connects to Player 1's tunnel URL in Chrome, while talking on Discord and running **[Flowseal/zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube)** (`winws.exe` + WinDivert DPI bypass).
  - *Deferred Backlog Note:* Brother's Chrome currently blocks WebRTC UDP (`LocalCand=[]` due to extension/browser `disable_non_proxied_udp` policy). Keep this documented for potential future WebRTC P2P work, though WSS Relay over Pinggy (`~215ms`) is the primary focus right now.
- **Git Repositories / Worktrees:**
  - **Main User Directory (Where the user double-clicks `.bat` scripts):** `C:\Users\Egor\Documents\Projects\NES_Online` (branch: `master`)
  - **Agent Worktree (if active):** `C:\Users\Egor\.gemini\antigravity\worktrees\NES_Online\power_blade_coop_netcode` (branch: `power_blade_coop_netcode`)
  - **CRITICAL RULE FOR AGENTS:** Always merge verified commits from the worktree branch into `C:\Users\Egor\Documents\Projects\NES_Online` (`master`) so the user's `.bat` files and running server immediately have the latest changes!
  - **PowerShell 5.1 Compatibility:** Use `;` instead of `&&` in Windows PowerShell commands. Keep `.ps1` scripts (`start_online.ps1`) strictly **pure 7-bit ASCII** (no Unicode em-dashes `—` or smart quotes) so Windows PowerShell 5.1 never throws a parser error when read without a UTF-8 BOM.

---

## 2. Real-World Network & ISP Findings (Singapore ↔ Russia)

We built two dedicated diagnostic suites (`/nettest` and `/autotest`) and ran live 2-PC benchmarks between Singapore (`PC 1`) and Russia (`PC 2`). Here is what we proved empirically:

### A. Tunnel Provider Comparison (`pinggy.io` vs `localhost.run`)
| Metric (Real 2-PC SG ↔ RU Test) | `localhost.run` (`*.lhr.life`) | `pinggy.io` (`*.free.pinggy.net`) | Notes |
| :--- | :--- | :--- | :--- |
| **Stage 1: Peer WSS RTT (Med / Min)** | `689 ms` (`Min 664 ms`, `Avg 735 ms`) | **`217 ms` (`Min 209 ms`, `Avg 254 ms`)** | `pinggy.io` routes directly via Singapore/Asia edge (`3.2x` lower ping, near physical fiber limit). |
| **Stage 3: Bidirectional 60fps NES Stream (3s)** | `180/180` (`MaxGap 292 ms`) | **`180/180` (`MaxGap 103 ms`)** | `0%` packet loss in both directions using **20Hz 3-frame micro-batching**. |
| **Stage 4: 16 KB Chunked Transfer (CRC32)** | `2,623 ms` (`6.1 KB/s`) | **`439 ms` (`36.4 KB/s`)** | `6x` faster on Pinggy. |
| **Stage 4: 64 KB Chunked Transfer (CRC32)** | `8,516 ms` (`7.5 KB/s`) | **`413 ms` (`155 KB/s`)** | `20x` faster on Pinggy. |
| **Stage 5: 256 KB ROM Transfer (CRC32)** | `45,411 ms` (`5.6 KB/s`) | **`616 ms` (`415.6 KB/s`)** | **`73x` faster (`0.61s` for a full 256 KB NES ROM!)** |
| **Stage 6: Post-Transfer Cooldown Ping** | `634 ms` (`Delta -101 ms`) | **`219 ms` (`Min 208 ms`, `Delta -35 ms`)** | Zero residual bufferbloat after 256 KB transfer. |

### B. Why WebRTC Direct UDP (`Stage 2`) Was Blocked on PC 2 — And How `zapret` Works
1. **Brother's Chrome Browser (`PC 2`):**
   - In Stage 2 of `/autotest`, `PC 1` (Singapore) gathered `LocalCand=[host,srflx]`, while `PC 2` (Russia) finished ICE gathering (`ICE=stable/new/complete`) with **`LocalCand=[]`** (0 local candidates—not even a LAN `host` candidate).
   - **Root Cause:** A Chrome browser extension (VPN/proxy/anti-censorship extension) on `PC 2` sets Chrome's `webRTCIPHandlingPolicy` to `disable_non_proxied_udp` (which persists in Chrome Incognito unless the extension is disabled or another browser like Microsoft Edge is used).
2. **`Flowseal/zapret-discord-youtube` Interaction:**
   - On Windows in Russia, `zapret-discord-youtube` (`winws.exe`) intercepts UDP ports `443`, `19294–19344`, and `50000–50100` (`--wf-udp=443,19294-19344,50000-50100 --filter-l7=discord,stun --dpi-desync=fake`).
   - Standard STUN port `3478` is ignored by default `zapret` scripts, whereas Google STUN ports **`19302` / `19305`** (`stun.l.google.com:19302`, `stun1.l.google.com:19302`, `stun2.l.google.com:19305`) and **`443`** (`stun.nextcloud.com:443`) fall directly inside `zapret`'s whitelisted UDP range.
   - However, because **WSS Relay over `pinggy.io` already achieves `209–217 ms` RTT and `415.6 KB/s` throughput over TCP Port 443**, online NES gameplay works at full speed over WSS Relay even when WebRTC UDP is completely blocked!

### C. Three Critical Protocol Lessons Learned (Do Not Regress!)
1. **Never Flood SSH Tunnels at 60+ Packets/Sec (`20Hz` Micro-Batching):**
   - Sending 60 packets/sec in both directions (`120 pkt/s` total) over an SSH reverse tunnel (`localhost.run`) causes SSH mux packet-rate throttling and wedges the WebSocket (`code=1006`).
   - **Solution Implemented:** In both `/autotest` (Stage 3) and the main NES console (`public/index.html`), WSS Relay sends inputs **immediately on any button press/release (`maskChanged`)** for `0 ms` extra input lag, and batches steady held inputs **every 3rd frame (`20Hz` = `20 pkt/s`)**. Since each `netplay_input` packet carries a sliding window of the last **32 frames** (`inputs[0..31]`), this delivers `180/180` (`100%`) of frames with zero tunnel congestion.
2. **Stream `16 KB` Chunks Continuously (No Per-Chunk Stop-and-Wait ACKs):**
   - Sending a `64 KB` or `256 KB` payload as a single giant WebSocket frame stalls SSH tunnels.
   - Conversely, waiting for an application-level ACK from Russia after every 2 chunks (`MAX_IN_FLIGHT = 2`) pays a full round-trip latency penalty every 16 KB and prevents the TCP congestion window (`cwnd`) from ramping up (`6.4 KB/s` vs `415 KB/s`).
   - **Solution Implemented:** Slice large transfers (ROMs & benchmarks) into **`16 KB` base64 chunks** (`diag_xfer_chunk` / `rom_chunk_data`) written continuously into the WebSocket, with a single final CRC32 verification ACK (`diag_xfer_ack` / `sync_ack`) at the end.
3. **Never Reorder or Delay Relay Messages on the Server (`server/relay_server.mjs`):**
   - `server/relay_server.mjs` must forward all room messages **synchronously and strictly in FIFO order**. Previously, a server-side `pumpPeerBulkQueue` delayed `diag_xfer_chunk` while forwarding `diag_xfer_end` immediately, causing `end` to arrive before `chunk` and triggering false `MISSING_CHUNKS`. Keep the relay server strictly FIFO.

---

## 3. Repository Architecture & File Map

### One-Click Windows Launchers (Root Directory)
- **[`start_online.ps1`](file:///C:/Users/Egor/Documents/Projects/NES_Online/start_online.ps1):** Master PowerShell launcher.
  - Kills any stale process on port `8080`.
  - Starts `node server/relay_server.mjs`.
  - Generates a passwordless Ed25519 SSH key (`logs/pinggy_ed25519`) so `pinggy.io` never prompts for a password.
  - Launches either `pinggy.io` (`-Tunnel pinggy -Region auto|ap|eu`, mapping to `a.pinggy.io`, `ap.a.pinggy.io`, `eu.a.pinggy.io`) or `localhost.run` (`-Tunnel localhost.run`) with `-T -o IPQoS=lowdelay` and registers tunnel/region metadata via `POST /api/tunnel-info`.
  - Parses the public HTTPS tunnel URL, **copies the brother's link to the Windows Clipboard**, and **opens the local browser automatically**.
- **[`PLAY_NES_PINGGY.bat`](file:///C:/Users/Egor/Documents/Projects/NES_Online/PLAY_NES_PINGGY.bat) / [`PLAY_NES_PINGGY_AP.bat`](file:///C:/Users/Egor/Documents/Projects/NES_Online/PLAY_NES_PINGGY_AP.bat) / [`PLAY_NES_PINGGY_EU.bat`](file:///C:/Users/Egor/Documents/Projects/NES_Online/PLAY_NES_PINGGY_EU.bat):** One-click launchers for the **NES Netplay Game Console** (`/?room=NOVA`) via `pinggy.io` (`auto`, `ap` Singapore edge, or `eu` Frankfurt edge).
- **[`RUN_NETTEST_PINGGY.bat`](file:///C:/Users/Egor/Documents/Projects/NES_Online/RUN_NETTEST_PINGGY.bat):** One-click launcher for the **Interactive 2-PC Block Sandbox & Manual Workbench** (`/nettest?room=NOVA`) via `pinggy.io`.
- **[`RUN_AUTOTEST_PINGGY.bat`](file:///C:/Users/Egor/Documents/Projects/NES_Online/RUN_AUTOTEST_PINGGY.bat) / [`RUN_AUTOTEST_PINGGY_AP.bat`](file:///C:/Users/Egor/Documents/Projects/NES_Online/RUN_AUTOTEST_PINGGY_AP.bat) / [`RUN_AUTOTEST_PINGGY_EU.bat`](file:///C:/Users/Egor/Documents/Projects/NES_Online/RUN_AUTOTEST_PINGGY_EU.bat):** One-click launchers for the **Zero-Click 6-Stage Automated Benchmark** (`/autotest`) via `pinggy.io` (`auto`, `ap`, or `eu`).
- **[`RUN_NES_GAME.bat`](file:///C:/Users/Egor/Documents/Projects/NES_Online/RUN_NES_GAME.bat) / [`RUN_NETTEST.bat`](file:///C:/Users/Egor/Documents/Projects/NES_Online/RUN_NETTEST.bat) / [`RUN_AUTOTEST.bat`](file:///C:/Users/Egor/Documents/Projects/NES_Online/RUN_AUTOTEST.bat):** Fallback launchers using `localhost.run`.

### Frontend Pages (`public/`)
1. **[`public/index.html`](file:///C:/Users/Egor/Documents/Projects/NES_Online/public/index.html) (`/`) — Universal NES Netplay Console:**
   - **Empty Boot & Zero-Transfer Lockstep ROM Sync:** Starts with an empty console (no default ROM auto-loaded into memory) and displays a live 2-Player ROM Ready & Sync Status Overlay (`#lobbyOverlay`). Both players select the same `.nes` ROM locally (exchanging only a lightweight `rom_status` `{ romName, romCrc32 }` packet), and as soon as their CRC32s match (or when either clicks `Reset`), `match_start_req` / `match_start_ack` fresh-boots both emulators at Frame `#0` simultaneously in lockstep without transferring 256 KB ROM payloads.
   - **Clean Pixels by Default:** CRT scanlines (`#scanlinesOverlay`) are OFF by default (`CRT: OFF / ON` button in the top bar).
   - **Live 2-PC Gameplay Telemetry Auto-Logger:** Automatically collects 2-second time-series telemetry samples and sync/stall/desync events from both PC 1 and PC 2 during online play and saves them to **`logs/gameplay_telemetry_latest.txt`** and **`logs/gameplay_telemetry_latest.json`**.
   - Includes a toggleable **Debug Drawer** showing live deterministic RAM CRC32 sync, transport status (`P2P` vs `WSS Relay`), rollback depth, clock rift, live controller inspector, and a `Copy Telemetry` button.
2. **[`public/net_debug.html`](file:///C:/Users/Egor/Documents/Projects/NES_Online/public/net_debug.html) (`/nettest`) — Interactive 2-PC Block Sandbox & Manual Workbench:**
   - Features the **Live 2-PC Cursor & Input Sandbox** (red `P1` and cyan `P2` blocks controlled via `WASD` / `Arrow Keys` / mouse drag at normalized 60Hz delta-time, capped to 30Hz over WSS).
   - Manual buttons for testing `16 KB`, `64 KB`, `256 KB`, and `512 KB` transfers, 60Hz packet streams, WebRTC STUN/TURN matrix, and pure HTTPS polling fallback (`/api/http-tunnel`).
3. **[`public/autotest.html`](file:///C:/Users/Egor/Documents/Projects/NES_Online/public/autotest.html) (`/autotest`) — Zero-Click 6-Stage Automated Benchmark:**
   - Auto-joins room `"AUTO"` on load. As soon as `PC 1` and `PC 2` are both connected, automatically runs all 6 stages (1. WSS Baseline Ping, 2. WebRTC STUN/TURN/Zapret Matrix, 3. Bidirectional 60Hz NES Input Stream, 4. 16 KB & 64 KB Transfers, 5. 256 KB Transfer + Tail Ping, 6. Post-Transfer Cooldown Ping).
   - Automatically saves the combined PC 1 + PC 2 report to **`logs/autotest_latest.txt`** and **`logs/autotest_latest.json`** on the host PC so the AI agent can read `logs/autotest_latest.txt` directly without copy-pasting.

### Core Netplay & Emulator Engine (`src/`)
- **[`src/netplay_engine.mjs`](file:///C:/Users/Egor/Documents/Projects/NES_Online/src/netplay_engine.mjs):**
  - **GGPO-Style Rollback + Input Delay + Clock-Rift Balancing Engine (`NesNetplayEngine`):** Synchronizes 1-byte controller bitmasks for Port 1 (`$4016`) and Port 2 (`$4017`). Configured for high-ping links (`inputDelayFrames = 3`, `maxRollbackFrames = 36`, `saveBufferSize = 96`, `enableRiftPacing = true`). Uses GGPO Clock-Rift calculation (`riftFrames = (myLead - peerLead) * 0.5`) to keep both PCs centered around 0 frame rift without hitting hard `maxRollbackFrames` stalls.
  - **Zero-GC Fast Binary Savestates & Dirty-Tile Epoch CHR-RAM (`saveFastState` / `loadFastState`):** Saves and restores full CPU, PPU, VRAM, OAM, CHR-RAM, APU, and Mapper state in **`~0.1 ms`** per frame using pre-allocated typed arrays and per-tile monotonic epoch tracking (`_tileEpoch` / `chrRamTileEpochs`) so Mapper 7/2 CHR-RAM games like *Battletoads & Double Dragon* only copy modified tiles.
  - **Compact Network State Export (`exportSyncState` / `importSyncState`):** Strips transient 1.5 MB PPU pixel render buffers and maps CHR-ROM tiles by `_vromRef`, shrinking lockstep state snapshots from `~1.8 MB` down to **`~18–25 KB`**.
  - **Upgraded `jsnes` PPU Fixes (`patchJsnes8x16Sprites`):**
    1. Fixes upstream `jsnes` 8x16 sprite odd-bank bug (`topTileNum + 256` instead of `topTileNum - 1 + 256`).
    2. Flushes visible scanline background (`renderBgScanline`) before HBlank (`curX >= 256`) `$2006`/`$2005` scroll writes so bottom HUDs/menus in games like *Power Blade 2* never jitter vertically.
  - **Deterministic Sync Verification (`computeDeterministicHash`):** Computes a 32-bit CRC32 of NES CPU RAM (`$0000-$07FF`), CPU registers, and PPU VRAM (`$2000-$3FFF`) every 30 frames to verify `SYNC_OK` across both PCs and auto-heal on any desync.

### Backend Server & Automated QA (`server/` & `tools/`)
- **[`server/relay_server.mjs`](file:///C:/Users/Egor/Documents/Projects/NES_Online/server/relay_server.mjs):**
  - Serves `/`, `/nettest`, `/autotest`, `/vendor/jsnes.js`, `/api/local-roms`, `/api/local-rom`, `/api/tunnel-info`, `/api/http-tunnel` (HTTPS polling fallback), `/api/autotest-report` (`logs/autotest_latest.txt`), and `/api/gameplay-telemetry` (`logs/gameplay_telemetry_latest.txt`).
  - Disables Nagle's algorithm (`socket.setNoDelay(true)`) on all HTTP and WebSocket connections for minimum latency.
- **[`tools/test_net_diagnostics.mjs`](file:///C:/Users/Egor/Documents/Projects/NES_Online/tools/test_net_diagnostics.mjs):** Automated test suite verifying `/nettest`, `/autotest`, chunked transfers, 60Hz streams, and `/api/http-tunnel`.
- **[`tools/test_coop_qa.mjs`](file:///C:/Users/Egor/Documents/Projects/NES_Online/tools/test_coop_qa.mjs):** Automated 2-client netplay QA suite verifying Mappers 0/1/2/4 fast savestates, CHR-RAM dirty-tile epoch rollbacks, GGPO clock-rift balancing, 3,600-frame (60s) chaos rollback stress test with `0` desyncs, zero-transfer lockstep `match_start_req`/`ack`, and live gameplay telemetry logging.

---

## 4. Quick Verification Commands for Agents

Before committing and merging any changes, run both automated test suites:
```powershell
node tools/test_net_diagnostics.mjs; node tools/test_coop_qa.mjs
```
And always merge worktree commits back to the main repo:
```powershell
git -C "C:\Users\Egor\Documents\Projects\NES_Online" merge power_blade_coop_netcode
```
