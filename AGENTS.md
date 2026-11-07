# AI Agent Instructions & Project Context (`NES_Online`)

> Auto-loaded context for AI coding agents. Keep this file under 250 lines
> and 80 characters per line. Deep-dive docs live in `docs/`.

## 1. Environment & Operational Rules

- **Player 1 (Host / User):** Singapore (`PC 1`, Windows, PowerShell 5.1).
  Runs `PLAY_NES_PINGGY_AP.bat` (`http://localhost:8080` + Pinggy `ap` tunnel).
- **Player 2 (Brother):** Isilkul, Omsk Oblast, Russia (`PC 2`, Windows).
  Connects to the Pinggy HTTPS/WSS URL while running `zapret-discord-youtube`.
- **Main Repository vs Worktree Rule (CRITICAL):**
  - Main repo: `C:\Users\Egor\Documents\Projects\NES_Online` (`master`)
  - Worktree (`power_blade_coop_netcode` branch):
    `~/.gemini/antigravity/worktrees/NES_Online/power_blade_coop_netcode`
  - Always fast-forward merge verified commits into `master` of the main repo
    so `PLAY_NES_PINGGY_AP.bat` immediately runs the latest code.
- **PowerShell 5.1 Compatibility:**
  - Use `;` instead of `&&` when chaining PowerShell commands.
  - Keep `.ps1` scripts (`start_online.ps1`) strictly **7-bit ASCII** (no
    Unicode em-dashes or smart quotes) so PowerShell 5.1 parses without BOM.
- **Baseline Tag:** `stable2` (`64176b6`) marks the verified pre-cleanup state.

## 2. Code Style & Clean Code Rules (Strictly Enforced)

Run `npm run check:style` (`node tools/check_code_style.mjs`) to verify all
rules before committing:

1. **Line Width Limit (`<= 80` characters):**
   - Every line in `.mjs`, `.js`, `.css`, `.html`, `.ps1`, and `.md` files
     must be **80 characters or fewer**.
2. **File Size Limit (`<= 250` lines target, `<= 350` lines hard cap):**
   - Target **150-250 lines** per file; never exceed **350 lines**.
   - Split growing files into cohesive, single-responsibility ES modules.
3. **Clean Code Principles:**
   - **Single Responsibility (SRP):** Separate HTML structure, CSS styles
     (`public/css/`), and JS logic (`public/js/`, `src/`, `server/`).
   - **Small Functions:** Target `<= 40` lines per function. Use guard clauses
     and early returns instead of deep nesting (max 3 indentation levels).
   - **Explicit Constants:** Replace magic numbers with named `UPPER_SNAKE_CASE`
     constants.
   - **DRY Reusability:** Share common helpers (CRC32, binary/base64 encoding,
     transport framing, audio ring buffer) across modules.
4. **Explicit Rule Exceptions (Whitelisted in `tools/check_code_style.mjs`):**
   - **Vendor / Lock / Binary / Log files:** `node_modules/`, `/vendor/`,
     `package-lock.json`, `local/*.nes`, `logs/*`.
   - **Lookup & Register Tables (`*_tables.mjs`):** Static hardware register
     lists (`CPU_SCALAR_PROPS`, `PPU_SCALAR_PROPS`), 6502 test ROM byte tables,
     and STUN/TURN server lists.
   - **Unbreakable Tokens:** Lines containing a single long URL (`https://...`),
     `file:///` link, SVG path `d="..."`, or Markdown table row.

## 3. Repository Architecture Map

- **`PLAY_NES_PINGGY_AP.bat` & `start_online.ps1`:**
  One-click Windows launcher (`pinggy.io` Asia-Pacific edge, auto clipboard +
  browser open). UI includes a top-bar switch between Game (`/`) & `/autotest`.
- **`src/` (Universal Deterministic Multi-Console Netplay Engine):**
  - `src/netplay_engine.mjs` & `src/netplay_packets.mjs` —
    `RollbackNetplayEngine` (`NesNetplayEngine`) GGPO rollback, 32-bit input
    masks, asymmetric input delay (`0f..5f`), clock-rift pacing, and smoothing.
  - `src/core_adapter.mjs` & `src/sega_gpgx_core.mjs` — Multi-console adapter
    (`NesCoreAdapter` + `GenericCoreAdapter`), `CONSOLE_PROFILES`, and
    WebAssembly `Genesis Plus GX` (`public/vendor/`) Sega Mega Drive (`320x224`)
    & Master System / Game Gear (`256x192`) core with ZRLE sparse state sync.
  - `src/jsnes_ppu_patches.mjs`, `src/jsnes_mapper_and_sprite_patches.mjs` &
    `src/ppu_register_tables.mjs` — `patchJsnes8x16Sprites` (HBlank `$2006` /
    `$2005` / `$2000` scanline flush, 8x16 sprites, 16-sprite scanline limit,
    and deterministic post-render anti-lag CPU overclock).
  - `src/fast_savestate.mjs` — Zero-GC binary snapshots (`saveFastState` /
    `loadFastState`), dirty-epoch CHR-RAM, and compact `exportSyncState`.
  - `src/crc32.mjs` — Precomputed CRC32, hex formatting, and RAM/VRAM hashing.
- **`public/` (Browser Frontend):**
  - `public/index.html`, `public/css/`, `public/js/` — Main NES Netplay Console,
    5-slot fast save/load (`save_slots.mjs`), custom keybinds & Z/X swap
    (`key_bindings.mjs`), fullscreen/auto-center & 1x..8x turbo speed
    (`viewport_and_speed.mjs`), drag-drop & `.zip`/`.rar`/`.7z` loader
    (`rom_archive.mjs`), 48kHz DRC audio, Dual-WSS + WebRTC, Lobby.
  - `public/autotest.html` & `public/net_debug.html` — Zero-click 6-stage
    2-PC benchmark (`/autotest`) and interactive network workbench (`/nettest`).
- **`server/` (FIFO WebSocket & HTTP Relay Server):**
  - `server/relay_server.mjs`, `server/room_manager.mjs`,
    `server/archive_extractor.mjs`, `server/report_formatters.mjs` — Node
    HTTP/WSS server, `.zip`/`.rar`/`.7z` ROM unpacker, Dual-WS striping, and
    telemetry auto-save.
- **`tools/` (Automated QA & Style Verification):**
  - `npm test` — Runs `test_coop_qa.mjs`, `test_net_diagnostics.mjs`, and
    `test_real_roms.mjs`.
  - `npm run check:style` — Verifies 80-char width and 350-line file limits.

## 4. Deep-Dive Reference Docs (Read On Demand)

- [Netplay & Emulator Architecture](docs/NETPLAY_ARCHITECTURE.md)
- [Singapore-Russia Network & Tunnel Findings](docs/NETWORK_AND_TUNNELS.md)
- [SG-RU Netplay & Factorio Guide](docs/SINGAPORE_RUSSIA_NETPLAY_GUIDE.md)
