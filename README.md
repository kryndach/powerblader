# Universal NES Online Netplay Console (GGPO Rollback)

Browser-based 2-player online NES emulator with **GGPO-style rollback netcode**,
**independent per-player input lag selection (`0f..5f`)**, **zero-GC binary
savestates**, and **Russia/DPI-friendly Dual-WebSocket (`wss://`) streaming**
tuned for long-distance links (Singapore ↔ Omsk, Russia at ~215 ms RTT).

---

## Quick Start (One-Click Windows Launcher)

1. Place your `.nes` ROM files inside the `local/` folder.
2. Double-click **`PLAY_NES_PINGGY_AP.bat`**.
   - Starts the local Node.js relay server on `http://localhost:8080`.
   - Opens a low-latency `pinggy.io` Asia-Pacific (`ap`) HTTPS/WSS tunnel.
   - Copies your brother's invite link (`https://.../?room=NOVA`) to your
     Windows Clipboard and opens your browser automatically.
3. Both players select the **same `.nes` file** in the UI — the match starts
   automatically in lockstep at **Frame `#0`** with zero ROM upload delay.
4. To run the automated 2-PC network benchmark at any time, click **`AutoTest`**
   in the top bar of the UI (or open `/autotest`).

---

## Controls & Top-Bar Options

| Control | Player Input / Action |
| :--- | :--- |
| **D-Pad (Move)** | `W A S D` or `Arrow Keys` (or USB Gamepad D-Pad / Stick) |
| **B Button (Attack)** | `X` or `K` (or Gamepad Button 2 / 3) |
| **A Button (Jump)** | `Z` or `J` (or Gamepad Button 0 / 1) |
| **Select / Start** | `Shift` / `Enter` (or Gamepad Select / Start) |
| **Lag Selector** | Choose `0f (0ms)` .. `5f (83ms)` or `Auto` independently per PC |
| **Volume Slider** | Adjust game audio `0%-100%` or click `Vol` to mute/unmute |
| **CRT Toggle** | Switch retro scanline overlay `OFF` (sharp pixels) or `ON` |
| **AutoTest Button** | Switch to the 6-stage 2-PC network benchmark (`/autotest`) |

---

## Developer Commands

```bash
# Install dependencies
npm install

# Run all automated unit, network & real-ROM rollback test suites
npm test

# Verify 80-column line width & 350-line file size rules
npm run check:style

# Start local relay server on http://localhost:8080
npm start
```

---

## Documentation

- **[`AGENTS.md`](AGENTS.md):** AI agent rules, code style guidelines, and
  repository map.
- **[`docs/NETPLAY_ARCHITECTURE.md`](docs/NETPLAY_ARCHITECTURE.md):** GGPO
  rollback engine, PPU accuracy patches, and DRC audio resampling details.
- **[`docs/NETWORK_AND_TUNNELS.md`](docs/NETWORK_AND_TUNNELS.md):** Empirical
  Singapore ↔ Russia tunnel benchmarks and protocol optimizations.
