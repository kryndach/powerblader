# Implementation Plan: Pinggy Regional Testing, Empty-Boot ROM Sync, Emulator Speed & Netcode Telemetry

> **Status:** Implemented & Verified  
> **Locations:** Host in **Singapore** (`PC 1`) ↔ Brother in **Isilkul, Omsk Oblast, Russia** (`PC 2`)

---

## 1. Pinggy Regional Testing (`-Region ap | eu | auto`)
**Goal:** Test whether routing through Pinggy's **Asia-Pacific (`ap.a.pinggy.io` - Singapore)** or **Europe (`eu.a.pinggy.io` - Frankfurt)** edge node gives lower and steadier ping between Singapore and Isilkul (Omsk Oblast).

### Changes:
1. **[`start_online.ps1`](file:///C:/Users/Egor/Documents/Projects/NES_Online/start_online.ps1):**
   - Add parameter `[ValidateSet("auto", "ap", "eu")] [string]$Region = "auto"`.
   - Map `auto -> a.pinggy.io`, `ap -> ap.a.pinggy.io`, and `eu -> eu.a.pinggy.io`.
   - Pass the active tunnel & region label into the server/autotest metadata so `/autotest` reports explicitly display `Tunnel: pinggy (Region: ap)` vs `Tunnel: pinggy (Region: eu)`.
2. **One-Click Regional Benchmark Launchers:**
   - Create **`RUN_AUTOTEST_PINGGY_AP.bat`** (`-Tunnel pinggy -Region ap -Mode autotest`).
   - Create **`RUN_AUTOTEST_PINGGY_EU.bat`** (`-Tunnel pinggy -Region eu -Mode autotest`).

---

## 2. Remove Retro CRT Scanlines Overlay (Clean Pixels by Default + Toggle)
**Goal:** Remove the dark horizontal "retro lines" across all pixels by default and give the user a toggle button if they ever want them.

### Root Cause:
- [`public/index.html`](file:///C:/Users/Egor/Documents/Projects/NES_Online/public/index.html#L233-L242) renders `<div class="crt-scanlines" id="scanlinesOverlay"></div>` over the canvas (`background: linear-gradient(...)`, `background-size: 100% 4px`).

### Changes:
1. **[`public/index.html`](file:///C:/Users/Egor/Documents/Projects/NES_Online/public/index.html):**
   - Hide `#scanlinesOverlay` (`display: none`) by default so the NES canvas renders 100% clean, sharp pixels.
   - Add a **`CRT Lines: OFF`** toggle button in the top control bar to switch scanlines `OFF / ON` on demand.

---

## 3. Empty Emulator Boot + Crystal-Clear "Same File on Both PCs" Sync Workflow
**Goal:** Remove *Power Blade 2* as the auto-loaded default game, free it from startup memory, eliminate ROM transfer confusion, and make starting/resetting a 2-player game 100% predictable without transferring ROM files over the network.

### Root Cause of Current Confusion:
- Previously, `discoverLocalRoms()` automatically loaded `files[0]` (*Power Blade 2*) into memory on startup (`isAutoDefaultRom = true`) and tried to push `rom_chunk` transfers + `25 KB` savestates whenever a player connected or changed ROMs.
- If both players selected a ROM around the same time, their transfers/sessions collided and left one emulator paused (`syncPaused = true`) until someone clicked `Reset`.

### Changes:
1. **Start with an Empty Emulator (Zero Default ROM in Memory):**
   - On page load, `discoverLocalRoms()` populates the `-- Select Game --` dropdown list from `local/` **without loading any ROM into memory**.
   - Legacy Power Blade 2-specific memory-sync code (`src/coop_core.mjs`) is completely unused by the main console.
2. **Clear On-Screen 2-Player Lobby & ROM Status Overlay:**
   - Display a clear status card directly on the TV screen until the match starts:
     - **You (`P1` / `P2`):** `No ROM selected` OR `Loaded: Battletoads & Double Dragon [CRC32: 596428B2] ✔`
     - **Partner (`P2` / `P1`):** `Waiting for partner to select ROM...` OR `Loaded: Battletoads & Double Dragon [CRC32: 596428B2] ✔`
3. **Zero-Transfer Local ROM Matching + Simultaneous Frame `#0` Lockstep Barrier:**
   - Whenever either player selects a `.nes` file (via `Load .NES` button, drag-and-drop, or dropdown), only a tiny **60-byte `rom_status` message** (`{ romName, romCrc32 }`) is sent to the partner—**no ROM bytes are transferred**.
   - **If CRC32s differ:** Show a clear warning banner: `⚠ MISMATCH: You have "GameA.nes", Partner has "GameB.nes" — Select the same file!`
   - **As soon as both players have the same `romCrc32` loaded:**
     - Trigger a lightweight **Frame `#0` Start Barrier (`match_start_req` → `match_start_ack` → `match_go`)** (`<100 bytes` total, zero savestate or ROM transfer needed because both emulators fresh-boot the exact same ROM from Frame `#0`!).
     - Show a clear banner: `✔ BOTH PLAYERS READY — STARTING AT FRAME #0!` and unpause both emulators simultaneously.
   - **Clicking `Reset`:** Triggers the exact same lightweight Frame `#0` barrier handshake so both PCs always hard-reset to Frame `#0` together with 100% reliability.

---

## 4. Fix Slowdown in *Battletoads & Double Dragon* & Maximum Netcode Optimization
**Goal:** Fix the slow/sluggish gameplay seen in *Battletoads & Double Dragon - The Ultimate Team (U)* and maximize smoothness over the ~215ms Singapore ↔ Omsk link.

### Root Causes Identified in [`src/netplay_engine.mjs`](file:///C:/Users/Egor/Documents/Projects/NES_Online/src/netplay_engine.mjs) & [`public/index.html`](file:///C:/Users/Egor/Documents/Projects/NES_Online/public/index.html):
1. **No GGPO Clock-Rift / Frame-Advantage Balancing:**
   - Without rift balancing, whichever PC starts stepping first (or if one browser tab has a 200ms hiccup) gets **15–36 frames ahead** of the other PC and *stays* that far ahead forever.
   - The ahead PC then hits `framesAhead > maxRollbackFrames` and **stalls repeatedly** (dropping emulation speed from `60 FPS` to `40–48 FPS` = slow-motion gameplay!), while also forcing deep 15–30 frame rollbacks on every button press.
2. **Spiral-of-Death in `runTick` Accumulator + Redundant PPU Pixel Rendering During Rollback:**
   - During a rollback of `N` frames (`for (let f = rbFrame; f < currentFrame; f++)`), `nes.frame()` was rendering full `256x240` background & sprite pixels into `ppu.buffer` for intermediate historical frames whose video output is immediately discarded (`suppressCallbacks = true`).
   - Furthermore, *Battletoads & Double Dragon* is a **Mapper 7 (AxROM) 8 KB CHR-RAM game** (`vromCount === 0`), so `saveFastState` was copying `32 KB` of `chrRamPix` on every single re-simulated frame during a rollback!
   - If a rollback took `>16.6ms`, `while (accumulatorMs >= FRAME_DURATION_MS)` tried to run 2–3 frames on the next tick, causing frame-rate slowdown.

### Changes:
1. **GGPO Time-Rift / Frame-Advantage Sync (`src/netplay_engine.mjs`):**
   - Include `peerLead = currentFrame - lastConfirmedRemoteFrame` in every `netplay_input` packet.
   - Compute true clock rift: $\text{riftFrames} = \frac{\text{myLead} - \text{peerLead}}{2}$.
   - Gently pace the ahead PC by `+0.5` to `+1` frame wait when `riftFrames > 2`, keeping both Singapore and Omsk PCs centered at `riftFrames ≈ 0` so rollbacks stay shallow (`~3–5 frames`) and Rift stalls (`stallFrames`) drop to **0**.
2. **Fast Rollback Re-Simulation & Dirty-Flag CHR-RAM Snapshots (`src/netplay_engine.mjs`):**
   - Track a `_chrRamDirty` flag on `ppu.ptTile` writes so CHR-RAM games like *Battletoads & Double Dragon* only copy `chrRamPix` when CHR-RAM was actually modified, cutting savestate time in half.
   - Cap `while (accumulatorMs >= FRAME_DURATION_MS)` in `public/index.html` to at most `2` steps per RAF tick (clamping excess accumulator drift) so a single browser hiccup never causes a multi-second slow-motion spiral.

---

## 5. Live 2-PC Gameplay Telemetry Logger (`logs/gameplay_telemetry_latest.txt`)
**Goal:** Automatically collect and save detailed netcode & emulator telemetry to disk while you and your brother play, so the AI agent can inspect exact performance data after any play session.

### Changes:
1. **Client-Side Telemetry Collector (`public/index.html`):**
   - Every 2 seconds during online play (and immediately on any desync, stall burst, or FPS drop `<55`), both PC 1 and PC 2 record a time-series sample:
     - `fps`, `frame`, `riftFrames`, `rttMs`, `jitterMs`, `inputDelay`, `rollbacksPerSec`, `lastRbDepth`, `maxRbDepth`, `stallsDelta`, `stepMs`, `txPktRate`, `rxPktRate`, `maxRxGapMs`, `syncStatus`, `localHash`, `remoteHash`.
   - Syncs PC 2's telemetry summary to PC 1 and posts the combined 2-PC log to `/api/gameplay-telemetry`.
2. **Server-Side Auto-Save (`server/relay_server.mjs`):**
   - Saves a human-readable + AI-readable report to **`logs/gameplay_telemetry_latest.txt`** and **`logs/gameplay_telemetry_latest.json`** continuously during gameplay.
   - Adds a **`📋 Copy Gameplay Log`** button in the Debug drawer as well.

---

## 6. Deferred Backlog (Do Not Work On Yet)
- **WebRTC Direct UDP Unblocking on Brother's Chrome (`PC 2`):**
  - Documented in `AGENT_ONBOARDING.md`. Brother's Chrome in Isilkul currently reports `LocalCand=[]` due to a browser extension/setting (`disable_non_proxied_udp`). Keep on hold while we optimize the ~215ms Pinggy WSS Relay path.
