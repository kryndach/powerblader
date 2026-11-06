// jsnes PPU Accuracy, HBlank Scroll Split, Headless Speed & Anti-Lag Overclock
import {
  patchFastMapperBankSwitching,
  patch8x16SpriteRenderer,
  isCpuInTightWaitLoop
} from './jsnes_mapper_and_sprite_patches.mjs';

const MAX_POST_RENDER_OVERCLOCK_SCANLINES = 240;

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

  if (!nes.ppu) return;
  const ppu = nes.ppu;
  if (ppu.vramMirrorTable) {
    for (let a = 0x3f20; a < 0x4000; a++) {
      ppu.vramMirrorTable[a] = 0x3f00 | (a & 0x1f);
    }
  }
  if (ppu._patched8x16) return;
  ppu._patched8x16 = true;
  ppu._hasTightWaitLoop = false;
  ppu._overclockScanlines = 0;
  ppu._inOverclock = false;

  const origMirroredWrite = ppu.mirroredWrite.bind(ppu);
  ppu.mirroredWrite = function (address, value) {
    if ((address & 0x3fff) >= 0x3f00) {
      return origMirroredWrite(0x3f00 | (address & 0x1f), value);
    }
    return origMirroredWrite(address, value);
  };

  const origEndScanline = ppu.endScanline.bind(ppu);
  ppu.endScanline = function () {
    if (
      this.scanline === 261 &&
      this.f_nmiOnVblank === 1 &&
      (this.f_bgVisibility === 1 || this.f_spVisibility === 1)
    ) {
      const waiting = isCpuInTightWaitLoop(this.nes.cpu);
      if (waiting) {
        this._hasTightWaitLoop = true;
      } else if (
        this._hasTightWaitLoop &&
        this._overclockScanlines < MAX_POST_RENDER_OVERCLOCK_SCANLINES
      ) {
        this._overclockScanlines++;
        this._inOverclock = true;
        this.regsToAddress();
        this.cntsToAddress();
        return;
      }
    }
    this._overclockScanlines = 0;
    this._inOverclock = false;
    return origEndScanline();
  };

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
