// jsnes PPU Accuracy, HBlank Scroll Split, 8x16 Sprite & Headless Speed Patches

function patchFastMapperBankSwitching(mmap) {
  if (!mmap || mmap._fastBankPatched) return;
  mmap._fastBankPatched = true;
  mmap._bankAt8000 = -1;
  mmap._bankAtC000 = -1;

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
    this.nes.ppu.triggerRendering();
    const b = bank % vromCount;
    this.nes.ppu.vramMem.set(this.nes.rom.vrom[b], address);
    const vromTile = this.nes.rom.vromTile[b];
    const baseIndex = address >> 4;
    const ptTile = this.nes.ppu.ptTile;
    for (let i = 0; i < 256; i++) ptTile[baseIndex + i] = vromTile[i];
  };

  mmap.load1kVromBank = function (bank1k, address) {
    const vromCount = this.nes.rom ? this.nes.rom.vromCount : 0;
    if (vromCount === 0) return;
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
}

function patch8x16SpriteRenderer(ppu) {
  ppu.renderSpritesPartially = function (startscan, scancount, bgPri) {
    if (this.f_spVisibility !== 1) return;
    const mmap = this.nes.mmap;
    const ptTile = this.ptTile;
    const buffer = this.buffer;
    const sprPalette = this.sprPalette;
    const pixrendered = this.pixrendered;

    for (let scan = startscan; scan < startscan + scancount; scan++) {
      if (scan < 0 || scan >= 240) continue;
      const count = this.scanlineSpriteCount[scan];
      if (count === 0) continue;
      const oamBase = scan * 32;

      for (let i = 0; i < count; i++) {
        const sprY = this.scanlineSecondaryOAM[oamBase + i * 4 + 0];
        const sprTile = this.scanlineSecondaryOAM[oamBase + i * 4 + 1];
        const sprAttr = this.scanlineSecondaryOAM[oamBase + i * 4 + 2];
        const sprX = this.scanlineSecondaryOAM[oamBase + i * 4 + 3];

        const vertFlip = (sprAttr >> 7) & 1;
        const horiFlip = (sprAttr >> 6) & 1;
        const priority = (sprAttr >> 5) & 1;
        const palAdd = (sprAttr & 3) << 2;
        if (priority !== bgPri) continue;

        if (this.f_spriteSize === 0) {
          const tileIdx =
            this.f_spPatternTable === 0 ? sprTile : sprTile + 256;
          const sprBaseAddr = this.f_spPatternTable === 0 ? 0x0000 : 0x1000;
          const dy = sprY + 1;
          const fineY = scan - dy;
          if (fineY < 0 || fineY >= 8) continue;

          const t = mmap.getSpritePatternTile
            ? mmap.getSpritePatternTile(tileIdx)
            : ptTile[tileIdx];
          if (t) {
            t.render(
              buffer, 0, fineY, 8, fineY + 1, sprX, dy,
              palAdd, sprPalette, horiFlip, vertFlip, i, pixrendered
            );
          }
          mmap.latchAccess(sprBaseAddr + sprTile * 16 + 8);
        } else {
          const sprBaseAddr = (sprTile & 1) !== 0 ? 0x1000 : 0x0000;
          const topTileNum = sprTile & 0xfe;
          const top = (sprTile & 1) !== 0 ? topTileNum + 256 : topTileNum;
          const dy = sprY + 1;
          const fineY = scan - dy;
          if (fineY < 0 || fineY >= 16) continue;

          const isTopHalf = fineY < 8;
          const tileOff = isTopHalf ? (vertFlip ? 1 : 0) : vertFlip ? 0 : 1;
          const tileFineY = isTopHalf ? fineY : fineY - 8;
          const t = mmap.getSpritePatternTile
            ? mmap.getSpritePatternTile(top + tileOff)
            : ptTile[top + tileOff];
          if (t) {
            t.render(
              buffer, 0, tileFineY, 8, tileFineY + 1, sprX,
              dy + (isTopHalf ? 0 : 8), palAdd, sprPalette,
              horiFlip, vertFlip, i, pixrendered
            );
          }
          mmap.latchAccess(sprBaseAddr + topTileNum * 16 + 8);
          mmap.latchAccess(sprBaseAddr + (topTileNum + 1) * 16 + 8);
        }
      }
    }
  };
}

export function patchJsnes8x16Sprites(nes) {
  if (!nes) return;

  if (!nes._patchedLoadRomHook) {
    nes._patchedLoadRomHook = true;
    if (typeof nes.loadROM === 'function') {
      const origLoadROM = nes.loadROM.bind(nes);
      nes.loadROM = function (data) {
        const res = origLoadROM(data);
        patchJsnes8x16Sprites(this);
        return res;
      };
    }
    if (typeof nes.reset === 'function') {
      const origReset = nes.reset.bind(nes);
      nes.reset = function () {
        const res = origReset();
        patchJsnes8x16Sprites(this);
        return res;
      };
    }
  }

  if (
    nes.rom &&
    !nes.rom._vromRefTagged &&
    nes.rom.vromCount > 0 &&
    Array.isArray(nes.rom.vromTile)
  ) {
    nes.rom._vromRefTagged = true;
    for (let b = 0; b < nes.rom.vromTile.length; b++) {
      const bank = nes.rom.vromTile[b];
      if (!bank) continue;
      for (let t = 0; t < bank.length; t++) {
        if (bank[t]) bank[t]._vromRef = (b << 8) | (t & 0xff);
      }
    }
  }

  patchFastMapperBankSwitching(nes.mmap);
  if (!nes.ppu || nes.ppu._patched8x16) return;
  const ppu = nes.ppu;
  ppu._patched8x16 = true;

  function flushCurrentScanlineIfHblank() {
    if (
      ppu.scanline >= 21 &&
      ppu.scanline <= 260 &&
      ppu.curX >= 256 &&
      !ppu.scanlineAlreadyRendered &&
      (ppu.f_bgVisibility === 1 || ppu.f_spVisibility === 1)
    ) {
      ppu.cntHT = ppu.regHT;
      ppu.cntH = ppu.regH;
      ppu.renderBgScanline(true, ppu.scanline + 1 - 21);
      ppu.scanlineAlreadyRendered = true;
    }
  }

  const origWriteVRAMAddress = ppu.writeVRAMAddress.bind(ppu);
  ppu.writeVRAMAddress = function (address) {
    flushCurrentScanlineIfHblank();
    if (!this.firstWrite) this.validTileData = false;
    return origWriteVRAMAddress(address);
  };

  const origScrollWrite = ppu.scrollWrite.bind(ppu);
  ppu.scrollWrite = function (value) {
    flushCurrentScanlineIfHblank();
    return origScrollWrite(value);
  };

  const origUpdateControlReg1 = ppu.updateControlReg1.bind(ppu);
  ppu.updateControlReg1 = function (value) {
    flushCurrentScanlineIfHblank();
    return origUpdateControlReg1(value);
  };

  ppu._nextTileEpoch = 1;
  const origPatternWrite = ppu.patternWrite.bind(ppu);
  ppu.patternWrite = function (address, value) {
    const t = this.ptTile && this.ptTile[address >> 4];
    if (t) {
      this._nextTileEpoch = (this._nextTileEpoch || 1) + 1;
      t._tileEpoch = this._nextTileEpoch;
    }
    return origPatternWrite(address, value);
  };

  ppu._mirrorCache = new Map();
  const origSetMirroring = ppu.setMirroring.bind(ppu);
  ppu.setMirroring = function (mirroring) {
    if (mirroring === this.currentMirroring) return;
    const cached = this._mirrorCache.get(mirroring);
    if (!cached) {
      origSetMirroring(mirroring);
      this._mirrorCache.set(mirroring, {
        vramSlice: this.vramMirrorTable.slice(0x2000, 0x3000),
        ntable1: this.ntable1.slice(0, 4)
      });
      return;
    }
    this.currentMirroring = mirroring;
    this.triggerRendering();
    this.vramMirrorTable.set(cached.vramSlice, 0x2000);
    for (let i = 0; i < 4; i++) this.ntable1[i] = cached.ntable1[i];
  };

  ppu._headlessFrame = false;
  const origStartFrame = ppu.startFrame.bind(ppu);
  ppu.startFrame = function () {
    if (this._headlessFrame) {
      this.scanlineSpriteCount.fill(0);
      this.scanlineSprite0.fill(0);
      this.pixrendered.fill(65);
      return;
    }
    return origStartFrame();
  };

  const origRenderFramePartially = ppu.renderFramePartially.bind(ppu);
  ppu.renderFramePartially = function (startScan, scanCount) {
    const mt = this.nes.rom ? this.nes.rom.mapperType : 0;
    if (this._headlessFrame && mt !== 9 && mt !== 10 && mt !== 5) {
      this.validTileData = false;
      return;
    }
    return origRenderFramePartially(startScan, scanCount);
  };

  const origEndFrame = ppu.endFrame.bind(ppu);
  ppu.endFrame = function () {
    if (this._headlessFrame) return;
    return origEndFrame();
  };

  const origRenderBgScanline = ppu.renderBgScanline.bind(ppu);
  ppu.renderBgScanline = function (bgbuffer, scan) {
    const mt = this.nes.rom ? this.nes.rom.mapperType : 0;
    if (
      this._headlessFrame &&
      (this.hitSpr0 || !this.scanlineSprite0[scan]) &&
      mt !== 9 &&
      mt !== 10 &&
      mt !== 5
    ) {
      this.cntHT = this.regHT;
      this.cntH = this.regH;
      this.curNt = this.ntable1[(this.cntV << 1) + this.cntH];
      if (scan < 240 && scan - this.cntFV >= 0) {
        this.cntH = (this.regH + 1) & 1;
        this.curNt = this.ntable1[(this.cntV << 1) + this.cntH];
        this.validTileData = true;
      }
      this.cntFV++;
      if (this.cntFV === 8) {
        this.cntFV = 0;
        this.cntVT++;
        if (this.cntVT === 30) {
          this.cntVT = 0;
          this.cntV = (this.cntV + 1) & 1;
          this.curNt = this.ntable1[(this.cntV << 1) + this.cntH];
        } else if (this.cntVT === 32) {
          this.cntVT = 0;
        }
        this.validTileData = false;
      }
      return;
    }
    return origRenderBgScanline(bgbuffer, scan);
  };

  patch8x16SpriteRenderer(ppu);
}
