// jsnes Fast Mapper Bank Caching, 8x16/Overflow Sprite Renderer & Anti-Lag CPU
export function patchFastMapperBankSwitching(mmap) {
  if (!mmap || mmap._fastBankPatched) return;
  mmap._fastBankPatched = true;
  mmap._bankAt8000 = -1;
  mmap._bankAtC000 = -1;
  mmap._vromAt0000 = -1;
  mmap._vromAt1000 = -1;

  mmap.loadRomBank = function (bank, address) {
    const romCount = this.nes.rom ? this.nes.rom.romCount : 0;
    if (!romCount) return;
    bank %= romCount;
    if (address === 0x8000) {
      if (this._bankAt8000 === bank) return;
      this._bankAt8000 = bank;
    } else if (address === 0xc000) {
      if (this._bankAtC000 === bank) return;
      this._bankAtC000 = bank;
    }
    this.nes.cpu.mem.set(this.nes.rom.rom[bank], address);
  };

  mmap.load32kRomBank = function (bank, address) {
    const romCount = this.nes.rom ? this.nes.rom.romCount : 0;
    if (!romCount) return;
    const b0 = (bank * 2) % romCount;
    const b1 = (bank * 2 + 1) % romCount;
    if (
      address === 0x8000 &&
      this._bankAt8000 === b0 &&
      this._bankAtC000 === b1
    ) {
      return;
    }
    if (address === 0x8000) {
      this._bankAt8000 = b0;
      this._bankAtC000 = b1;
    }
    this.nes.cpu.mem.set(this.nes.rom.rom[b0], address);
    this.nes.cpu.mem.set(this.nes.rom.rom[b1], address + 16384);
  };

  mmap.load8kRomBank = function (bank8k, address) {
    const romCount = this.nes.rom ? this.nes.rom.romCount : 0;
    if (!romCount) return;
    this._bankAt8000 = -1;
    this._bankAtC000 = -1;
    const bank16k = (bank8k >> 1) % romCount;
    const offset = (bank8k & 1) << 13;
    const slice = this.nes.rom.rom[bank16k].subarray(offset, offset + 8192);
    this.nes.cpu.mem.set(slice, address);
  };

  mmap.loadVromBank = function (bank, address) {
    const vromCount = this.nes.rom ? this.nes.rom.vromCount : 0;
    if (vromCount === 0) return;
    const b = bank % vromCount;
    if (address === 0x0000) {
      if (this._vromAt0000 === b) return;
      this._vromAt0000 = b;
    } else if (address === 0x1000) {
      if (this._vromAt1000 === b) return;
      this._vromAt1000 = b;
    }
    this.nes.ppu.triggerRendering();
    this.nes.ppu.vramMem.set(this.nes.rom.vrom[b], address);
    const vromTile = this.nes.rom.vromTile[b];
    const baseIndex = address >> 4;
    const ptTile = this.nes.ppu.ptTile;
    for (let i = 0; i < 256; i++) ptTile[baseIndex + i] = vromTile[i];
  };

  mmap.load8kVromBank = function (bank4kStart, address) {
    const vromCount = this.nes.rom ? this.nes.rom.vromCount : 0;
    if (vromCount === 0) return;
    this.loadVromBank(bank4kStart % vromCount, address);
    this.loadVromBank((bank4kStart + 1) % vromCount, address + 4096);
  };

  mmap.load1kVromBank = function (bank1k, address) {
    const vromCount = this.nes.rom ? this.nes.rom.vromCount : 0;
    if (vromCount === 0) return;
    this._vromAt0000 = -1;
    this._vromAt1000 = -1;
    this.nes.ppu.triggerRendering();
    const bank4k = Math.floor(bank1k / 4) % vromCount;
    const off = (bank1k % 4) * 1024;
    const slice = this.nes.rom.vrom[bank4k].subarray(off, off + 1024);
    this.nes.ppu.vramMem.set(slice, address);
    const vromTile = this.nes.rom.vromTile[bank4k];
    const baseIndex = address >> 4;
    const tileOff = (bank1k % 4) << 6;
    const ptTile = this.nes.ppu.ptTile;
    for (let i = 0; i < 64; i++) ptTile[baseIndex + i] = vromTile[tileOff + i];
  };

  mmap.load2kVromBank = function (bank2k, address) {
    const vromCount = this.nes.rom ? this.nes.rom.vromCount : 0;
    if (vromCount === 0) return;
    this._vromAt0000 = -1;
    this._vromAt1000 = -1;
    this.nes.ppu.triggerRendering();
    const bank4k = Math.floor(bank2k / 2) % vromCount;
    const off = (bank2k % 2) * 2048;
    const slice = this.nes.rom.vrom[bank4k].subarray(off, off + 2048);
    this.nes.ppu.vramMem.set(slice, address);
    const vromTile = this.nes.rom.vromTile[bank4k];
    const baseIndex = address >> 4;
    const tileOff = (bank2k % 2) << 7;
    const ptTile = this.nes.ppu.ptTile;
    for (let i = 0; i < 128; i++) ptTile[baseIndex + i] = vromTile[tileOff + i];
  };

  if (typeof mmap.executeCommand === 'function') {
    mmap._mmc3Regs = [0, 2, 4, 5, 6, 7, 0, 1];
    const origExec = mmap.executeCommand.bind(mmap);
    mmap.executeCommand = function (cmd, arg) {
      if (cmd >= 0 && cmd < 8) this._mmc3Regs[cmd] = arg;
      return origExec(cmd, arg);
    };

    const origWrite = mmap.write.bind(mmap);
    mmap.write = function (address, value) {
      if (address >= 0x8000 && (address & 0xe001) === 0x8000) {
        this.command = value & 7;
        const newPrg = (value >> 6) & 1;
        const newChr = (value >> 7) & 1;
        const prgDiff = newPrg !== this.prgAddressSelect;
        const chrDiff = newChr !== this.chrAddressSelect;
        this.prgAddressSelect = newPrg;
        this.chrAddressSelect = newChr;
        this.prgAddressChanged = false;
        if (prgDiff && this.nes.rom && this.nes.rom.romCount > 0) {
          const fixedBank = (this.nes.rom.romCount - 1) * 2;
          const r6 = this._mmc3Regs[6];
          if (newPrg === 0) {
            this.load8kRomBank(r6, 0x8000);
            this.load8kRomBank(fixedBank, 0xc000);
          } else {
            this.load8kRomBank(fixedBank, 0x8000);
            this.load8kRomBank(r6, 0xc000);
          }
        }
        if (chrDiff && this.nes.rom && this.nes.rom.vromCount > 0) {
          for (let c = 0; c < 6; c++) origExec(c, this._mmc3Regs[c]);
        }
        return;
      }
      return origWrite(address, value);
    };

    const origToJSON = mmap.toJSON.bind(mmap);
    mmap.toJSON = function () {
      const s = origToJSON();
      s._mmc3Regs = this._mmc3Regs.slice();
      return s;
    };

    const origFromJSON = mmap.fromJSON.bind(mmap);
    mmap.fromJSON = function (s) {
      origFromJSON(s);
      if (s && Array.isArray(s._mmc3Regs)) {
        this._mmc3Regs = s._mmc3Regs.slice();
      }
    };
  }
}

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
          this,
          scan,
          i,
          this.scanlineSecondaryOAM[oamBase + i * 4 + 0],
          this.scanlineSecondaryOAM[oamBase + i * 4 + 1],
          sprAttr,
          this.scanlineSecondaryOAM[oamBase + i * 4 + 3]
        );
      }

      if (count === 8 && this._noSpriteLimit && scan > 0) {
        let inRangeSeen = 0;
        let extraRendered = 0;
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
                  this,
                  scan,
                  7 + extraRendered,
                  sprY,
                  this.spriteMem[base + 1],
                  sprAttr,
                  this.spriteMem[base + 3]
                );
              }
            }
          }
        }
      }
    }
  };
}

export function isCpuInTightWaitLoop(cpu) {
  const pc = (cpu.REG_PC + 1) & 0xffff;
  const m = cpu.mem;
  const p0 = pc;
  const p3 = (pc - 3) & 0xffff;
  if (m[p0] === 0x4c && (m[p0 + 1] | (m[p0 + 2] << 8)) === p0) return true;
  if (m[p3] === 0x4c && (m[p3 + 1] | (m[p3 + 2] << 8)) === p3) return true;

  const b0 = pc;
  const b1 = (pc - 2) & 0xffff;
  const b2 = (pc + 2) & 0xffff;
  const b3 = (pc + 3) & 0xffff;
  if ((m[b0] & 0x1f) === 0x10 && (m[b0 + 1] === 0xfc || m[b0 + 1] === 0xfb)) {
    return true;
  }
  if ((m[b1] & 0x1f) === 0x10 && (m[b1 + 1] === 0xfc || m[b1 + 1] === 0xfb)) {
    return true;
  }
  if ((m[b2] & 0x1f) === 0x10 && m[(b2 + 1) & 0xffff] === 0xfc) return true;
  if ((m[b3] & 0x1f) === 0x10 && m[(b3 + 1) & 0xffff] === 0xfb) return true;

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
