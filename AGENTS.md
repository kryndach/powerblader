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
- **Mandatory Bug-Fix TDD Workflow (NO EXCEPTIONS):**
  1. **Reproduce:** Inspect `logs/` & code to pinpoint exact root cause.
  2. **Write Failing Test First:** Add a Node or Real-Chrome E2E test that
     reproduces the bug and verify it **FAILS** before editing production code.
  3. **Fix:** Implement the minimal, clean root-cause fix.
  4. **Verify Green:** Run `npm run check:style` and `npm test` (including 2-tab
     Chromium E2E `tools/test_browser_e2e.mjs`) before merging to `master`.
- **Never Deliver a Broken Build (MANDATORY PRE-DELIVERY GATE):**
  - Never rely solely on mocked child-process, SSH, or PowerShell unit tests
    when touching `.bat`, `.ps1`, server startup, tunnel routing, or UI boot.
  - Every `npm test` run MUST execute `tools/verify_release_smoke.mjs` (verifies
    all `PLAY_NES_*.bat` launchers, real PowerShell 5.1 AST + 7-bit ASCII on
    `start_online.ps1`, 32-bit/64-bit OpenSSH binaries, and real child-process
    `server/relay_server.mjs` boot with zero `stderr`).
  - **After merging to `master` (`...\Projects\NES_Online`):** ALWAYS run
    `node tools/verify_release_smoke.mjs --live-tunnel` inside the main repo
    main repo folder BEFORE telling the user a build is ready, confirming the
    exact files the user launches start cleanly and allocate a live HTTPS URL.

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
  - `src/core_adapter.mjs`, `src/sega_gpgx_core.mjs` &
    `src/fbneo_arcade_core.mjs` — Multi-console adapter (`NesCoreAdapter` +
    `GenericCoreAdapter`), `CONSOLE_PROFILES`, and WASM cores (`Genesis Plus GX`
    Sega MD/SMS, `Snes9x` SNES, and `FinalBurn Neo` Arcade `local/arcade/`,
    e.g., `tgm2p.zip`) with ZRLE sparse state sync.
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
    (`rom_archive.mjs`), 8x striped HTTP `Range` + IndexedDB CRC32 cache
    (`rom_fast_transfer.mjs`, `rom_idb_cache.mjs`), unified live transfer UI
    (`transfer_status_ui.mjs`), 48kHz DRC audio, Dual-WSS + WebRTC, Lobby.
  - `public/autotest.html` & `public/net_debug.html` — Zero-click 8-stage
    2-PC full-stack benchmark (`/autotest`) & network workbench (`/nettest`).
- **`server/` (FIFO WebSocket & HTTP Relay Server):**
  - `server/relay_server.mjs`, `server/room_manager.mjs`,
    `server/wire_rtt_prober.mjs`, `server/tunnel_manager.mjs`,
    `server/archive_extractor.mjs`, `server/room_rom_and_save_api.mjs` — Node
    HTTP/WSS server, auto-route SSH tunnel manager, C++ RFC 6455 `wire_rtt`
    prober, `.zip`/`.rar`/`.7z` unpacker, `206` Range ROM cache, Dual-WS.
- **`tools/` (Automated QA, Real-Browser E2E & Release Smoke Gate):**
  - `npm test` — Runs `test_coop_qa.mjs`, `test_net_diagnostics.mjs`,
    `test_real_roms.mjs`, `test_perf_and_edge_cases.mjs`, real 2-tab Chrome E2E
    `test_browser_e2e.mjs`, and `verify_release_smoke.mjs` (`verify:release`).
  - `npm run check:style` — Verifies 80-char width and 350-line file limits.

## 4. Deep-Dive Reference Docs (Read On Demand)

- [Netplay & Emulator Architecture](docs/NETPLAY_ARCHITECTURE.md)
- [Singapore-Russia Network & Tunnel Findings](docs/NETWORK_AND_TUNNELS.md)
- [SG-RU Netplay & Factorio Guide](docs/SINGAPORE_RUSSIA_NETPLAY_GUIDE.md)
