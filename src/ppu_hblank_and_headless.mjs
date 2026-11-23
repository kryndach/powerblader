// jsnes PPU HBlank/Late-$2000 Split Flush, Mirroring Cache & Headless Fast-Path
export function patchPpuHblankAndHeadless(ppu) {
  if (!ppu || ppu._patchedHblankAndHeadless) return;
  ppu._patchedHblankAndHeadless = true;

  if (ppu.vramMirrorTable) {
    for (let a = 0x3f20; a < 0x4000; a++) {
      ppu.vramMirrorTable[a] = 0x3f00 | (a & 0x1f);
    }
  }

  const origMirroredWrite = ppu.mirroredWrite.bind(ppu);
  ppu.mirroredWrite = function (address, value) {
    if ((address & 0x3fff) >= 0x3f00) {
      return origMirroredWrite(0x3f00 | (address & 0x1f), value);
    }
    return origMirroredWrite(address, value);
  };

  function flushCurrentScanlineIfHblank(minX = 256) {
    if (
      ppu.scanline >= 21 &&
      ppu.scanline <= 260 &&
      ppu.curX >= minX &&
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
    flushCurrentScanlineIfHblank(256);
    if (!this.firstWrite) this.validTileData = false;
    return origWriteVRAMAddress(address);
  };

  const origScrollWrite = ppu.scrollWrite.bind(ppu);
  ppu.scrollWrite = function (value) {
    flushCurrentScanlineIfHblank(256);
    return origScrollWrite(value);
  };

  const origUpdateControlReg1 = ppu.updateControlReg1.bind(ppu);
  ppu.updateControlReg1 = function (value) {
    const bgPtChanged = ((value >> 4) & 1) !== (this.regS ? 1 : 0);
    flushCurrentScanlineIfHblank(bgPtChanged ? 200 : 256);
    return origUpdateControlReg1(value);
  };

  ppu.triggerRendering = function () {
    if (this._inRendering) return;
    if (this.scanline >= 21 && this.scanline <= 260) {
      flushCurrentScanlineIfHblank(256);
      const targetScan =
        this.curX >= 256 ? this.scanline + 1 - 21 : this.scanline - 21;
      if (targetScan > this.lastRenderedScanline) {
        this.renderFramePartially(
          this.lastRenderedScanline + 1,
          targetScan - this.lastRenderedScanline
        );
        this.lastRenderedScanline = targetScan;
      }
    }
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
      for (let a = 0x3f20; a < 0x4000; a++) {
        this.vramMirrorTable[a] = 0x3f00 | (a & 0x1f);
      }
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
      mt !== 9 && mt !== 10 && mt !== 5
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
}
