// jsnes 8x16/Overflow Sprite Renderer & Deterministic Post-Render CPU Overclock
const MAX_POST_RENDER_OVERCLOCK_SCANLINES = 240;
const WAIT_BRANCH_OPS = new Set([0x10, 0x30, 0xd0, 0xf0]);
const WAIT_READ_ZP_OPS = new Set([0x24, 0xa4, 0xa5, 0xa6, 0xc4, 0xc5, 0xe4]);
const WAIT_READ_ABS_OPS = new Set([0x2c, 0xac, 0xad, 0xae, 0xcc, 0xcd, 0xec]);

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
        for (let n = 0; n < 64 && extraRendered < 8; n++) {
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

function isReadOnlyWaitBranch(m, branchAddr) {
  if (!WAIT_BRANCH_OPS.has(m[branchAddr])) return false;
  const rel = m[(branchAddr + 1) & 0xffff];
  if (rel === 0xfc) {
    return WAIT_READ_ZP_OPS.has(m[(branchAddr - 2) & 0xffff]);
  }
  if (rel === 0xfb) {
    return WAIT_READ_ABS_OPS.has(m[(branchAddr - 3) & 0xffff]);
  }
  return false;
}

export function isCpuInTightWaitLoop(cpu) {
  const pc = (cpu.REG_PC + 1) & 0xffff;
  const m = cpu.mem;
  const p0 = pc, p3 = (pc - 3) & 0xffff;
  if (m[p0] === 0x4c && (m[p0 + 1] | (m[p0 + 2] << 8)) === p0) return true;
  if (m[p3] === 0x4c && (m[p3 + 1] | (m[p3 + 2] << 8)) === p3) return true;

  if (
    isReadOnlyWaitBranch(m, pc) ||
    isReadOnlyWaitBranch(m, (pc - 2) & 0xffff) ||
    isReadOnlyWaitBranch(m, (pc + 2) & 0xffff) ||
    isReadOnlyWaitBranch(m, (pc + 3) & 0xffff)
  ) {
    return true;
  }

  for (let off = -3; off <= 36; off++) {
    const a = (pc + off) & 0xffff;
    if (m[a] === 0x4c) {
      const target = m[(a + 1) & 0xffff] | (m[(a + 2) & 0xffff] << 8);
      const span = a - target;
      if (target <= pc && pc <= a + 2 && span > 0 && span <= 40) {
        if (m[(target - 1) & 0xffff] === 0x58 || cpu.REG_SP === 0x01ff) {
          return true;
        }
      }
    }
  }
  return false;
}

export function setNesOverclockEnabled(nes, enabled) {
  const ppu = nes && nes.ppu;
  if (!ppu) return false;
  const next = Boolean(enabled);
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
  if (typeof ppu._overclockEnabled !== 'boolean') {
    ppu._overclockEnabled = false;
  }
  ppu._hasTightWaitLoop = false;
  ppu._overclockScanlines = 0;
  ppu._inOverclock = false;
  ppu._overclockCapped = false;

  const origEndScanline = ppu.endScanline.bind(ppu);
  ppu.endScanline = function () {
    if (
      this._overclockEnabled &&
      !this._overclockCapped &&
      this.scanline === 261 &&
      this.f_nmiOnVblank === 1 &&
      (this.f_bgVisibility === 1 || this.f_spVisibility === 1)
    ) {
      const waiting = isCpuInTightWaitLoop(this.nes.cpu);
      if (waiting) {
        this._hasTightWaitLoop = true;
      } else if (this._hasTightWaitLoop) {
        if (this._overclockScanlines < MAX_POST_RENDER_OVERCLOCK_SCANLINES) {
          this._overclockScanlines++;
          this._inOverclock = true;
          this.regsToAddress();
          this.cntsToAddress();
          return;
        }
        this._overclockCapped = true;
        this._hasTightWaitLoop = false;
      }
    }
    this._overclockScanlines = 0;
    this._inOverclock = false;
    return origEndScanline();
  };
}
