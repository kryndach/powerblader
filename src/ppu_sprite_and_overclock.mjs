// jsnes 8x16/Overflow Sprite Renderer & Deterministic Post-Render CPU Overclock
const MAX_POST_RENDER_OVERCLOCK_SCANLINES = 480;
const MAX_FORCE_OVERCLOCK_SCANLINES = 360;
const WAIT_BRANCH_OPS = new Set([0x10, 0x30, 0xd0, 0xf0]);
const WAIT_READ_ZP_OPS = new Set([
  0x05, 0x24, 0x25, 0x45, 0xa4, 0xa5, 0xa6, 0xc4, 0xc5, 0xe4
]);
const WAIT_READ_ABS_OPS = new Set([
  0x0d, 0x2c, 0x2d, 0x4d, 0xac, 0xad, 0xae, 0xcc, 0xcd, 0xec
]);
const WAIT_PURE_1B_OPS = new Set([0x8a, 0x98, 0xa8, 0xaa, 0xea]);
const WAIT_PURE_2B_OPS = new Set([0x09, 0x29, 0x49, 0xc0, 0xc9, 0xe0]);

function renderSingleSpriteRow(ppu, scan, i, sprY, sprTile, sprAttr, sprX) {
  const mmap = ppu.nes.mmap;
  const ptTile = ppu.ptTile;
  const vertFlip = (sprAttr >> 7) & 1;
  const horiFlip = (sprAttr >> 6) & 1;
  const palAdd = (sprAttr & 3) << 2;
  const dy = sprY + 1;
  const fineY = scan - dy;

  if (ppu.f_spriteSize === 0) {
    if (fineY < 0 || fineY >= 8) return;
    const tileIdx = ppu.f_spPatternTable === 0 ? sprTile : sprTile + 256;
    const sprBaseAddr = ppu.f_spPatternTable === 0 ? 0x0000 : 0x1000;
    const t = mmap.getSpritePatternTile
      ? mmap.getSpritePatternTile(tileIdx)
      : ptTile[tileIdx];
    if (t) {
      t.render(
        ppu.buffer, 0, fineY, 8, fineY + 1, sprX, dy,
        palAdd, ppu.sprPalette, horiFlip, vertFlip, i, ppu.pixrendered
      );
    }
    mmap.latchAccess(sprBaseAddr + sprTile * 16 + 8);
  } else {
    if (fineY < 0 || fineY >= 16) return;
    const sprBaseAddr = (sprTile & 1) !== 0 ? 0x1000 : 0x0000;
    const topTileNum = sprTile & 0xfe;
    const top = (sprTile & 1) !== 0 ? topTileNum + 256 : topTileNum;
    const isTopHalf = fineY < 8;
    const tileOff = isTopHalf ? (vertFlip ? 1 : 0) : vertFlip ? 0 : 1;
    const tileFineY = isTopHalf ? fineY : fineY - 8;
    const t = mmap.getSpritePatternTile
      ? mmap.getSpritePatternTile(top + tileOff)
      : ptTile[top + tileOff];
    if (t) {
      t.render(
        ppu.buffer, 0, tileFineY, 8, tileFineY + 1, sprX,
        dy + (isTopHalf ? 0 : 8), palAdd, ppu.sprPalette,
        horiFlip, vertFlip, i, ppu.pixrendered
      );
    }
    mmap.latchAccess(sprBaseAddr + topTileNum * 16 + 8);
    mmap.latchAccess(sprBaseAddr + (topTileNum + 1) * 16 + 8);
  }
}

export function patch8x16SpriteRenderer(ppu) {
  ppu._noSpriteLimit = true;
  ppu.renderSpritesPartially = function (startscan, scancount, bgPri) {
    if (this.f_spVisibility !== 1) return;
    const sprHeight = this.f_spriteSize === 0 ? 8 : 16;

    for (let scan = startscan; scan < startscan + scancount; scan++) {
      if (scan < 0 || scan >= 240) continue;
      const count = this.scanlineSpriteCount[scan];
      if (count === 0) continue;
      const oamBase = scan * 32;

      for (let i = 0; i < count; i++) {
        const sprAttr = this.scanlineSecondaryOAM[oamBase + i * 4 + 2];
        if (((sprAttr >> 5) & 1) !== bgPri) continue;
        renderSingleSpriteRow(
          this, scan, i,
          this.scanlineSecondaryOAM[oamBase + i * 4 + 0],
          this.scanlineSecondaryOAM[oamBase + i * 4 + 1],
          sprAttr,
          this.scanlineSecondaryOAM[oamBase + i * 4 + 3]
        );
      }

      if (count === 8 && this._noSpriteLimit && scan > 0) {
        let inRangeSeen = 0, extraRendered = 0;
        for (let n = 0; n < 64 && extraRendered < 24; n++) {
          const base = n * 4;
          const sprY = this.spriteMem[base];
          if (scan > sprY && scan <= sprY + sprHeight) {
            inRangeSeen++;
            if (inRangeSeen > 8) {
              const sprAttr = this.spriteMem[base + 2];
              extraRendered++;
              if (((sprAttr >> 5) & 1) === bgPri) {
                renderSingleSpriteRow(
                  this, scan, 7 + extraRendered, sprY,
                  this.spriteMem[base + 1], sprAttr, this.spriteMem[base + 3]
                );
              }
            }
          }
        }
      }
    }
  };
}

function verifySafeWaitBody(m, start, end) {
  let a = start, steps = 0;
  let readAddr = -1, incAddr = -1;
  while (a !== end && steps < 5) {
    const op = m[a];
    if (WAIT_READ_ZP_OPS.has(op)) {
      readAddr = m[(a + 1) & 0xffff];
      a = (a + 2) & 0xffff;
    } else if (WAIT_READ_ABS_OPS.has(op)) {
      readAddr = m[(a + 1) & 0xffff] | (m[(a + 2) & 0xffff] << 8);
      a = (a + 3) & 0xffff;
    } else if (WAIT_PURE_1B_OPS.has(op)) {
      a = (a + 1) & 0xffff;
    } else if (WAIT_PURE_2B_OPS.has(op)) {
      a = (a + 2) & 0xffff;
    } else if (op === 0xe6 && incAddr < 0) {
      incAddr = m[(a + 1) & 0xffff];
      a = (a + 2) & 0xffff;
    } else if (op === 0xee && incAddr < 0) {
      incAddr = m[(a + 1) & 0xffff] | (m[(a + 2) & 0xffff] << 8);
      a = (a + 3) & 0xffff;
    } else {
      return false;
    }
    steps++;
  }
  if (a !== end || readAddr < 0) return false;
  if (incAddr >= 0 && incAddr === readAddr) return false;
  return true;
}

function isShortLeafHelper(m, pc) {
  for (let off = 0; off <= 36; off++) {
    const op = m[(pc + off) & 0xffff];
    if (op === 0x60) return true; // RTS within 36 bytes
    if (op === 0x20) return false; // Nested JSR -> active game logic
  }
  return false;
}

function isPcInJmpWaitLoop(m, pc, sp) {
  const sp8 = sp & 0xff;
  for (let off = -3; off <= 36; off++) {
    const a = (pc + off) & 0xffff;
    if (m[a] !== 0x4c) continue;
    const target = m[(a + 1) & 0xffff] | (m[(a + 2) & 0xffff] << 8);
    const span = a - target;
    if (target <= pc && pc <= a + 2 && span > 0 && span <= 40) {
      if (m[(target - 1) & 0xffff] === 0x58 || sp8 === 0xff) return true;
      if (span >= 4 && span <= 12) {
        const br = (a - 2) & 0xffff;
        if (WAIT_BRANCH_OPS.has(m[br]) && m[(br + 1) & 0xffff] === 0x03 &&
            verifySafeWaitBody(m, target, br)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function isCpuInTightWaitLoop(cpu) {
  const pc = (cpu.REG_PC + 1) & 0xffff;
  const m = cpu.mem;
  const p0 = pc, p3 = (pc - 3) & 0xffff;
  if (m[p0] === 0x4c && (m[p0 + 1] | (m[p0 + 2] << 8)) === p0) return true;
  if (m[p3] === 0x4c && (m[p3 + 1] | (m[p3 + 2] << 8)) === p3) return true;

  for (let off = -2; off <= 8; off++) {
    const br = (pc + off) & 0xffff;
    if (!WAIT_BRANCH_OPS.has(m[br])) continue;
    const relByte = m[(br + 1) & 0xffff];
    if (relByte < 0xf2 || relByte > 0xfc) continue;
    const rel = relByte - 256;
    const target = (br + 2 + rel) & 0xffff;
    const distPc = (pc - target) & 0xffff;
    const span = (br - target) & 0xffff;
    if (distPc <= span + 2 && verifySafeWaitBody(m, target, br)) return true;
  }

  if (isPcInJmpWaitLoop(m, pc, cpu.REG_SP)) return true;
  if ((cpu.REG_SP & 0xff) === 0xfd && isShortLeafHelper(m, pc)) {
    const retPc = ((m[0x01fe] | (m[0x01ff] << 8)) + 1) & 0xffff;
    if (isPcInJmpWaitLoop(m, retPc, 0x01ff)) return true;
  }
  return false;
}

export function normalizeOverclockMode(val) {
  if (val === 2 || val === '2' || val === 'max') return 2;
  if (val === true || val === 1 || val === '1' || val === 'on') return 1;
  return 0;
}

export function setNesOverclockEnabled(nes, enabledOrMode) {
  const ppu = nes && nes.ppu;
  if (!ppu) return false;
  const mode = normalizeOverclockMode(enabledOrMode);
  const next = mode > 0;
  nes._overclockMode = mode;
  nes._overclockEnabled = next;
  ppu._overclockMode = mode;
  ppu._overclockEnabled = next;
  ppu._overclockScanlines = 0;
  ppu._inOverclock = false;
  ppu._overclockCapped = false;
  if (!next) ppu._hasTightWaitLoop = false;
  return next;
}

export function patchPostRenderOverclock(nes) {
  if (nes.papu && !nes.papu._patchedOverclockGuard) {
    nes.papu._patchedOverclockGuard = true;
    const papu = nes.papu;
    const origClockFrame = papu.clockFrameCounter.bind(papu);
    papu.clockFrameCounter = function (nCycles, alreadyAdvanced) {
      if (this.nes.ppu && this.nes.ppu._inOverclock) return;
      return origClockFrame(nCycles, alreadyAdvanced);
    };
    const origAdvanceFrame = papu.advanceFrameCounter.bind(papu);
    papu.advanceFrameCounter = function (nCycles) {
      if (this.nes.ppu && this.nes.ppu._inOverclock) return;
      return origAdvanceFrame(nCycles);
    };
  }
  const ppu = nes.ppu;
  if (!ppu || ppu._patchedOverclockEndScanline) return;
  ppu._patchedOverclockEndScanline = true;
  if (typeof ppu._overclockMode !== 'number') {
    ppu._overclockMode = typeof nes._overclockMode === 'number'
      ? nes._overclockMode : (ppu._overclockEnabled ? 1 : 0);
  }
  if (typeof ppu._overclockEnabled !== 'boolean') {
    ppu._overclockEnabled = ppu._overclockMode > 0;
  }
  ppu._hasTightWaitLoop = false;
  ppu._overclockScanlines = 0;
  ppu._inOverclock = false;
  ppu._overclockCapped = false;

  const origEndScanline = ppu.endScanline.bind(ppu);
  ppu.endScanline = function () {
    const mode = this._overclockMode || (this._overclockEnabled ? 1 : 0);
    if (
      mode > 0 &&
      this.scanline === 261 &&
      this.f_nmiOnVblank === 1 &&
      (this.f_bgVisibility === 1 || this.f_spVisibility === 1)
    ) {
      const waiting = isCpuInTightWaitLoop(this.nes.cpu);
      if (waiting) {
        this._hasTightWaitLoop = true;
        this._overclockCapped = false;
        this._overclockCooldown = 0;
      } else if (
        mode === 2 ||
        (this._hasTightWaitLoop && !this._overclockCapped &&
          !(this._overclockCooldown > 0))
      ) {
        const cap = mode === 2
          ? MAX_FORCE_OVERCLOCK_SCANLINES
          : MAX_POST_RENDER_OVERCLOCK_SCANLINES;
        if (this._overclockScanlines < cap) {
          this._overclockScanlines++;
          this._inOverclock = true;
          this.regsToAddress();
          this.cntsToAddress();
          return;
        }
        if (mode === 1) {
          this._overclockCapped = true;
          this._overclockCooldown = 8;
        }
      } else if (this._overclockCooldown > 0) {
        this._overclockCooldown--;
        if (this._overclockCooldown === 0) this._overclockCapped = false;
      }
    }
    this._overclockScanlines = 0;
    this._inOverclock = false;
    return origEndScanline();
  };
}
