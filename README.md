# Netplay Deck — Multi-Console Browser Rollback Netplay

Browser-based 2-player online retro console (**NES / SNES / Sega Genesis /
Arcade**) with **GGPO-style rollback netcode**, **independent per-player input
lag selection (`0f..5f`)**, **zero-GC binary savestates**, **serverless WebRTC
P2P**, and **DPI-friendly Dual-WebSocket (`wss://`) streaming** tuned for
high-latency long-distance links (~220 ms RTT).

---

## Quick Start

### Option A: GitHub Pages (Zero Install / Serverless P2P)
1. Open the hosted static page on both PCs.
2. Enter the same **Room Code** + **Password** (4+ chars).
3. Player 1 clicks **Host P2P**; Player 2 clicks **Connect**.
4. Drag & drop or pick a ROM (`.nes`, `.sfc`, `.smc`, `.gen`, `.md`, `.zip`,
   `.7z`) — previously loaded games auto-cache in browser storage by CRC32.

### Option B: Local Relay + Tunnel (One-Click Windows Launcher)
1. Optionally place your own ROM files inside the local `local/` folder
   (gitignored — never committed).
2. Double-click **`PLAY_NES_AUTO.bat`** (or **`PLAY_NES_PINGGY_AP.bat`**).
   - Starts the local Node.js relay server on `http://localhost:8080`.
   - Opens a low-latency `pinggy.io` HTTPS/WSS tunnel with live route picker.
   - Copies Player 2's invite link (`https://.../?room=NOVA`) to your clipboard
     and opens your browser automatically.
3. Both players load the same ROM (or click **Send ROM** — cached ROMs load at
   0 KB over the wire).
4. To run the automated 2-PC network benchmark, click **`AutoTest`** in the top
   bar (or open `/autotest`).

---

## Controls & Top-Bar Options

| Control | Player Input / Action |
| :--- | :--- |
| **D-Pad (Move)** | `W A S D` or `Arrow Keys` (or USB Gamepad D-Pad / Stick) |
| **A / B / C / X / Y / Z** | `Z / X / C / Q / E / R` (customizable via `Keys`) |
| **Select / Start** | `Shift` / `Enter` (or Gamepad Select / Start) |
| **Lag Selector** | Choose `0f (0ms)` .. `5f (83ms)` or `Auto` independently |
| **Save / Load** | 5 save slots (`1`-`5`, `F6` Save, `F8` Load) + file export |
| **OC Toggle** | NES Anti-Lag Overclock (`ON` / `MAX` / `OFF`, synced) |
| **Volume / CRT** | Adjust game audio `0%-100%` or toggle CRT scanlines |
| **AutoTest / NetDebug** | 8-stage 2-PC benchmark (`/autotest`) & debugger (`/nettest`) |

---

## Developer Commands

```bash
# Install dependencies
npm install

# Run all 12 automated suites (uses synthetic ROMs + local/ if present)
npm test

# Verify 80-column line width & 350-line file size rules
npm run check:style

# Build static GitHub Pages bundle (dist-pages/)
npm run build:pages

# Start local relay server on http://localhost:8080
npm start
```

---

## Documentation

- **[`AGENTS.md`](AGENTS.md):** Coding guidelines, style rules, and repo map.
- **[`docs/NETPLAY_ARCHITECTURE.md`](docs/NETPLAY_ARCHITECTURE.md):** GGPO
  rollback engine, PPU accuracy patches, and DRC audio resampling details.
- **[`docs/NETWORK_AND_TUNNELS.md`](docs/NETWORK_AND_TUNNELS.md):** Empirical
  high-latency tunnel benchmarks and protocol optimizations.
- **[`HIGH_LATENCY_NETPLAY_GUIDE.md`](docs/HIGH_LATENCY_NETPLAY_GUIDE.md):**
  Deep-dive engineering notes for ~220 ms links and strict NAT/DPI networks.
