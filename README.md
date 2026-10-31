# Power Blade 2 (NES) — Browser Online Co-op (Singapore ↔ Russia)

Online 2-player cooperative multiplayer for **Power Blade 2 (NES, USA)** built following the [cranebeaker/coop-anything](https://github.com/cranebeaker/coop-anything) methodology (`AGENTS.md` & `playbook/console-emulators.md` Route B: Memory-Sync Co-op).

## Key Features

1. **Browser Dual-Emulator + RAM/Sprite Sync (`src/coop_core.mjs`)**
   - **Independent Cameras:** Each player runs their own 60 FPS NES emulator in the browser (`jsnes`). Neither player is dragged or killed by single-screen camera scroll locks, ladders, or Pause/Suit menus.
   - **Suit-Independent MMC3 CHR Sprite Compositing:** Captures pre-HUD-IRQ gameplay CHR banks (`scanline < 120`) and resolves every 8x16 sprite tile (`owner = 0` for Nova, `owner = 1..5` for Boomerangs & Suit Projectiles) to its global CHR-ROM index (`0..8191`). Player 1 and Player 2 can wear **different Power Suits simultaneously** (Normal, Newton, Patriot, Rocket, Wet) without MMC3 bank conflicts or 8-sprites-per-scanline flickering.
   - **Distinct Player 2 Co-op Palette & Off-Screen Radar:** Renders your partner with a custom Emerald/Cyan/Gold co-op armor palette, an overhead `P2` badge, and an edge-of-screen directional radar indicator (`<P2`, `P2>`, `^P2`, `vP2`) when in the same room but off-screen.
   - **Shared Co-op Combat & Progression:**
     - **Shared Enemy & Boss Damage (`$049A,X` & `$04A9`):** Both players damage and kill enemies, Mid-Boss Security Orbs, and Stage Bosses together.
     - **Shared Power Suits (`$0056`) & Cleared Stages (`$003B`):** Unlocking a Suit or clearing a stage immediately unlocks it for both players.
     - **Instant Warp-to-Partner (`[T]`):** Press `T` (or click **⚡ Warp to Partner**) at any time to teleport into your partner's exact Stage, Room, and screen position side-by-side while keeping your equipped Suit.
     - **Built-in AI Co-op Partner Bot (`🤖 Spawn Co-op Bot`):** Test 2-player co-op solo right in your browser before your brother joins.

2. **Russia / DPI-Friendly Networking (`server/relay_server.mjs`)**
   - Uses standard **WebSockets over TLS (`wss://` on port 443)** on the same origin as the HTTPS web page—avoiding raw UDP and foreign WebRTC STUN/TURN servers that are throttled or blocked by Russian ISP DPI (Roskomnadzor TSPU).
   - **Zero External CDN Dependencies:** `jsnes` is served directly from `/vendor/jsnes.js` so nothing depends on external CDNs (`unpkg`, `jsdelivr`, etc.) that may be filtered in Russia.
   - **Snapshot Interpolation Buffer:** Smoothly interpolates remote movement and boomerangs (default `65 ms` buffer) across ~150–180 ms Singapore ↔ Russia RTT with **0 ms local input latency**.

---

## Quick Start (Local)

1. Place your legally dumped **Power Blade 2 (U) [!].nes** ROM (`SHA-256: 17ff0f30e6e6023995cae1f8a2c67d22fe680f65d37f2724dbb55116d8516bca`, `CRC32: D273B409`) inside `local/` (git-ignored).
2. Install dependencies & run the automated 2-client QA suite:
   ```bash
   npm install
   npm test
   ```
3. Start the Co-op Server:
   ```bash
   npm start
   ```
4. Open **http://localhost:8080** in two browser tabs (or click **🤖 Spawn Co-op Bot** in one tab) to test immediately!

---

## Playing Online (Singapore ↔ Russia Options)

Because the app uses a single port (`8080` locally, mapped to `443` HTTPS/WSS in production) and **never hosts or transmits the ROM from the cloud** (each player selects their `.nes` file once in the browser and it is cached in `IndexedDB`), you have two easy ways to connect with your brother in Russia:

### Option 1: Free Cloud Hosting (Render / Railway / Fly.io / VPS — Recommended, like `factorio.zone`)
Deploy this repo (which contains **zero ROM files**) to any Docker/Node.js host reachable from Russia (e.g. Render, Railway, Fly.io, or a small VPS in Finland/Kazakhstan/Singapore):
- Build command: `npm install`
- Start command: `npm start`
- Both you and your brother open `https://<your-app-url>/?room=NOVA`, drop `Power Blade 2 (U) [!].nes` onto the page once (cached in browser `IndexedDB`), and play!

### Option 2: Direct HTTPS Tunnel from Your PC
Run `npm start` on your PC and expose port `8080` over standard HTTPS/TLS port 443 using an SSH reverse tunnel (`ssh -R 80:localhost:8080 nokey@localhost.run` or `pinggy.io`). Send the `https://.../?room=NOVA` link to your brother.
