# Netplay & Emulator Architecture Reference

## 1. Universal Deterministic Rollback (`NesNetplayEngine`)

- **Synchronized Ports:** Synchronizes 1-byte controller bitmasks on NES Port 1
  (`$4016`) and Port 2 (`$4017`) across any Mapper (`0, 1, 2, 3, 4, 7`, etc.).
- **Asymmetric Independent Input Delay (`0f..5f`):**
  - `resetTimeline()` only pre-confirms `this.localPlayer`'s initial delay
    frames (`startFrame .. startFrame + inputDelayFrames - 1`).
  - Player 1 and Player 2 can select completely different input lag values
    (e.g. `2f` vs `0f` or `1f`) and change them mid-game without desyncing.
  - `stepNetplayFrame()` schedules local inputs up to `currentFrame +
    inputDelayFrames`, allowing input delay to shrink smoothly within 1-4
    frames when lowered mid-game.
- **GGPO Clock-Rift & Clump-Aware Pacing:**
  - Every `netplay_input` packet carries `inputDelay`, `peerLead`, and
    `rxClump`.
  - `receiveRemoteInputPacket()` normalizes `myLead` by subtracting
    `remoteInputDelayFrames` so asymmetric input delays never bias `rawRift`.
  - In the browser (`runTick`), **Sub-Frame Fractional Time-Sync** smoothly
    scales frame duration by up to `+/-3%` when `|riftFrames| > 0.25`, keeping
    both PCs locked in time without visible whole-frame skips.
- **1-Frame Visual Rollback Smoothing:**
  - When a rollback of depth `>= 4` frames occurs, the pre-rollback framebuffer
    is alpha-blended (`18%-25%`) with the newly corrected frame for 1 frame to
    soften horizontal sprite snaps.

## 2. `jsnes` Accuracy & Speed Patches (`src/jsnes_ppu_patches.mjs`)

- **Auto-Reapply Hook on `loadROM` / `reset`:**
  - `nes.loadROM()` in `jsnes` calls `this.reset()`, recreating `nes.ppu`,
    `nes.mmap`, and `nes.rom`. `patchJsnes8x16Sprites()` hooks `nes.loadROM`
    and `nes.reset` so all PPU/Mapper/VROM patches persist across online
    Frame `#0` lockstep starts and console resets.
- **HBlank Scroll Split Flush (`$2006` / `$2005` / `$2000`):**
  - Real NES hardware outputs visible pixels during dots `0..255` and applies
    HUD split scroll writes in HBlank (`curX >= 256`) for the next scanline.
  - Because `jsnes` waits until dot `341` (`endScanline`) to render the
    scanline, `flushCurrentScanlineIfHblank()` flushes `renderBgScanline`
    before both `firstWrite` and `!firstWrite` of `$2006`, `$2005`, and `$2000`
    when `curX >= 256`. This keeps *Power Blade 2*'s bottom HUD locked at
    `y = 184` with zero vertical scanline jitter.
- **8x16 Odd-Bank Sprite Fix:**
  - Fixes upstream `jsnes` bug where odd-bank 8x16 sprites subtracted 1 from
    an already-even `topTileNum` (`topTileNum + 256`).
- **True Headless PPU During Rollback (`_headlessFrame`):**
  - Skips RGB framebuffer clearing, sprite pixel compositing, and `O(256)` tile
    loops during intermediate rollback frames when Sprite 0 hit is not pending,
    advancing PPU scroll counters in `O(1)` (`~2x` faster rollbacks).
- **Fast `Uint8Array.set` Bank Switching & Mirroring Cache:**
  - Replaces `jsnes` byte-by-byte bank-switch loops and 56,192-iteration
    `setMirroring` loops with native `Uint8Array.set`, PRG/VROM bank caching
    (`_bankAt8000`, `_bankAtC000`, `_vromAt0000`, `_vromAt1000`), and a 4-entry
    mirroring cache.
- **Smart Post-Render Anti-Lag Overclock & 16-Sprite-Per-Scanline Renderer:**
  - In `src/jsnes_mapper_and_sprite_patches.mjs`, detects whether the 6502 CPU
    has reached its NMI-wait spin loop (`isCpuInTightWaitLoop`) at post-render
    scanline `261`. On heavy frames (e.g., *Chip 'n Dale Rescue Rangers 2* with
    many active objects/boxes/enemies), grants up to `240` extra post-render
    scanlines (`2x` CPU clock boost) with APU audio synthesis paused so the
    6502 CPU finishes its object loop before VBlank NMI without altering audio
    pitch or visible scanline timing. Also renders up to `16` sprites per
    scanline (`_noSpriteLimit`) to prevent sprite drop/flicker.
- **Save Slots (1-5) & Fast Save/Load (`F5`/`F8`) with Online Sync:**
  - `public/js/save_slots.mjs` persists 5 save slots per ROM CRC32 in memory
    and `localStorage`, and automatically broadcasts `state_sync` when loading
    a slot during 2-PC online co-op.

## 3. Fast Binary Savestates & DRC Audio Resampling

- **Zero-GC Binary Ring Buffer (`src/fast_savestate.mjs`):**
  - Pre-allocates typed arrays (`cpuMem`, `vramMem`, `spriteMem`, `ppuScalars`,
    `chrRamPix`) and tracks per-tile dirty epochs (`_tileEpoch`) so CHR-RAM
    games (*Battletoads & Double Dragon*) only copy modified 8x8 tiles.
- **Dynamic Rate Control (DRC) Audio (`public/js/audio_drc.mjs`):**
  - Uses a 48,000 Hz ring buffer with an `1,800`-sample prebuffer (`~37 ms`),
    `2,200`-sample target cushion (`~45 ms`), fractional read pointer with
    linear interpolation (`stepRate` in `0.95..1.05`), and a 48-sample (`1 ms`)
    post-rollback linear crossfade ramp so inputs/rollbacks never click or pop.
