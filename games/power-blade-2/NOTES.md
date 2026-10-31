# Power Blade 2 (NES) — Co-op Notes

Following [cranebeaker/coop-anything](https://github.com/cranebeaker/coop-anything) `AGENTS.md` and [playbook/console-emulators.md](https://github.com/cranebeaker/coop-anything/blob/main/playbook/console-emulators.md).

## Phase 0 & 2: Triage & Verified ROM Identity

### Observed Facts
- **Title:** *Power Blade 2* (North America, Oct 1992)
- **Developer / Publisher:** Natsume / Taito
- **File (in git-ignored `local/`):** `local/Power Blade 2 (U) [!].nes`
- **File Size:** `262,160` bytes (16-byte iNES header + 128 KB PRG-ROM + 128 KB CHR-ROM)
- **SHA-256:** `17ff0f30e6e6023995cae1f8a2c67d22fe680f65d37f2724dbb55116d8516bca`
- **PRG+CHR CRC32:** `D273B409`
- **iNES Header:** `4e 45 53 1a 08 10 40 00 00 00 00 00 00 00 00 00` (iNES Mapper `4` / Nintendo `MMC3`, 8x16KB PRG, 16x8KB CHR)

---

## Phase 3: Reverse-Engineered Architecture & RAM Map

Verified via static 6502 disassembly of PRG-ROM Banks 0, 1, 6, 7, 10, 14, 15 and dynamic execution probing in headless `jsnes` (`tools/re_probe.mjs`).

### 1. Camera & Room Coordinate Engine (`Bank 14 $D950–$DB10`, `Bank 15 $FDA9–$FE20`)
- **`$0022` (`stageId`):** Current stage index (`0..5` for Stages 1..6).
- **`$0087` (`roomId`):** Current room / scroll section within the stage.
- **`$0027` (`gameMode`):** `3` = Active Gameplay, `6` = Suit Transformation, `7` = Pause / Subscreen Menu (`$B243`, `$D25B`).
- **`$0097` (`scrollMode`):** `0` = Horizontal scrolling room; non-zero = Vertical scrolling room (`$FDA9`, `$FDF0`).
- **`$0066:$0067` (`cameraPage:cameraOffset`):** 16-bit camera scroll position within the current room:
  - When `$0097 == 0` (Horizontal room): `cameraWorldX = ($0066 << 8) | $0067` (wraps at 256 px per page, `$D9FE–$DA14`), `cameraWorldY = 0`.
  - When `$0097 != 0` (Vertical room): `cameraWorldX = 0`, `cameraWorldY = ($0066 * 240) + $0067` (wraps at `0xF0` = 240 px per vertical screen, `$DA5F–$DACC`).
- **`$00FD` / `$00FC` / `$00FF`:** Shadow registers written to PPU `$2005` (Scroll X, Scroll Y) and `$2000` (PPUCTRL) at `$EB5B–$EB71` before the scanline-192 MMC3 HUD split.

### 2. 22-Slot Struct-of-Arrays (SoA) Actor Engine (`$0400–$0717`, stride `0x16` = 22 bytes)
Every entity in the room occupies a slot `X` (`0 <= X < 22`):
- **Slot `0`:** Player (Nova)
- **Slots `1..5`:** Player Boomerangs & Power Suit Projectiles
- **Slots `6..21`:** Enemies, Pickups, Mid-Boss (Security Orb), and Stage Boss (**Slot `15`** is the Boss slot, whose HP at `$04A9` drives the HUD Boss Health bar at `$D531`).

| Base Address | Property | Verification Source |
|---|---|---|
| `$0400,X` | Actor Type / State (`0` = empty, `1` = explosion/pickup, `>= $50` = Boss/Mid-Boss) | Bank 7 `$B698–$B70B`, Bank 14 `$D36D` |
| `$0416,X` | Actor Status Flags (`$80` = dying / exploding / item state) | Bank 7 `$B70B` |
| `$042C,X` | Facing & Sprite Flip (`$40` = Left, `$00` = Right) | Bank 7 `$B243`, RAM probe |
| `$0442,X` | Animation / Pose ID | Bank 10 `$832C`, RAM probe |
| `$049A,X` | **Actor HP** (`$049A` = Player HP `0..16`; `$04A9` = Boss HP `0..32`; `$FF` = invincible) | Bank 7 `$B698–$B6A2`, Bank 14 `$D4ED`, `$D531` |
| `$04B0,X` | Screen Y High Byte (`0` = on screen) | Bank 15 `$FDA9` |
| `$04C6,X` | Screen Y Low Byte (`0..239`) | Bank 15 `$FDA9`, RAM probe |
| `$04F2,X` | Screen X High Byte (`0` = on screen) | Bank 15 `$FDF0` |
| `$0508,X` | Screen X Low Byte (`0..255`) | Bank 15 `$FDF0`, RAM probe |
| `$05B8,X` | Hit Invincibility / Mercy Timer | Bank 7 `$B243`, `$B60B` |
| `$05FA,X` | World X Low Byte | Bank 15 `$FDE5` |
| `$0610,X` | World X High Byte | Bank 15 `$FDE5` |
| `$0626,X` | World Y Low Byte | Bank 15 `$FDA9` |
| `$063C,X` | World Y High Byte | Bank 15 `$FDA9` |

### 3. OAM Sprite Generation & Exact Owner Tagging (`Bank 6 $8051–$813C`)
- The engine iterates `X = 0..21`, storing the current Actor Slot index in Zero Page **`$000D`** (`STX $0D` at `$8055`, `INC $0D` at `$8063`).
- It writes 8x16 (`PPUCTRL` bit 5 = 1) sprite entries to `$0200,Y..$0203,Y`, stepping the OAM index by `-15` slots (`+$C4` bytes mod 256) per sprite for flicker cycling, and clears unused OAM slots to `Y = $F4` (`244`).
- By recording `nes.cpu.mem[0x0D]` whenever `$0203 + s*4` is written, we classify every OAM sprite with 100% accuracy into:
  - `owner === 0`: Player avatar tiles
  - `1 <= owner <= 5`: Player boomerang / suit projectile tiles
  - `owner >= 6`: Enemy / boss / item tiles
- Furthermore, by resolving each 8x16 sprite's top and bottom 8x8 tiles to their **global CHR-ROM tile index (`0..8191`)** across the 128 KB CHR-ROM at capture time, Player 1 and Player 2 can wear **different Power Suits simultaneously** without MMC3 CHR bank conflicts!

### 4. Player Progression & Inventory (`Bank 14 $D250–$D560`)
- **`$009A`:** Active Suit (`0` = Normal, `1` = Newton, `2` = Patriot, `3` = Rocket, `4` = Wet).
- **`$0056`:** Collected Suits bitmask (`$01, $02, $04, $08`).
- **`$003B`:** Cleared Stages bitmask (`$01, $02, $04, $08`).
- **`$00A0`:** Current Suit Energy (`0..16`).
- **`$009D` / `$009E`:** Reserve E-Tanks (Life) and L-Tanks (Suit Energy).
- **`$009F`:** Extra Lives count.


---

## Phase 5 & 6: Critical Implementation Discovery & Automated Bot QA

### MMC3 Scanline-192 HUD IRQ CHR Bank Swap
- During Stage 1 testing with our headless 2-client bot suite (`tools/test_coop_qa.mjs`), we discovered that *Power Blade 2*'s MMC3 scanline counter IRQ at **Scanline 192** swaps PPU `$0000–$1FFF` (`nes.ppu.ptTile`) to CHR Bank 25 (`globalChrId = 6400..6655`) to render the bottom status bar.
- Reading `nes.ppu.ptTile` at the *end* of `nes.frame()` (Scanline 240) therefore yielded blank HUD CHR tiles instead of Nova's gameplay sprite tiles.
- **Fix in `src/coop_core.mjs`:** Hooked `nes.mmap.load1kVromBank(bank1k, address)` and captured `this.gameplayPtTile[0..511]` whenever `nes.ppu.scanline < 120` (top-of-frame gameplay rendering, prior to the Scanline-192 HUD IRQ).

### Automated QA Suite Results (`npm test` / `node tools/test_coop_qa.mjs`)
```text
=== Power Blade 2 Co-op Automated Bot & Network Chaos QA Suite ===

[PASS] Test 1: ROM Verified (SHA-256=17ff0f30e6e60239..., CRC32=D273B409)
[PASS] Test 2: WebSocket Relay Room Handshake (SG=P2, RU=P1)
[PASS] Test 3: Independent Camera + Puppet Overlay under 180ms RTT / 25ms Jitter / 2% Loss (SG camX=475, RU camX=512, drawnSprites=9, drawnPixels=362)
[PASS] Test 4: Cross-Suit MMC3 CHR Rendering (SG Suit=0, RU Suit=2, drawnPixels=353)
[PASS] Test 5a: Shared Enemy Kill Synced over WebSocket Relay (Enemy #21 HP 1 -> 0)
[PASS] Test 5b: Shared Boss HP Bar Synced over WebSocket Relay (Boss HP 32 -> 28)
[PASS] Test 6: Shared Power Suit Unlock & Stage Clear Bitmasks Synced
[PASS] Test 7: Warp-to-Partner over WebSocket (Synced Room/Camera & Preserved Partner Suit)

ALL 7 AUTOMATED CO-OP QA TESTS PASSED!
```
