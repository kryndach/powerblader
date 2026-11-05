// Universal Deterministic NES Netplay Engine (GGPO-style Rollback + Input Delay)
// Works with any NES ROM (Mapper 0, 1, 2, 3, 4, etc.) by synchronizing 1-byte controller inputs
// on Port 1 ($4016) and Port 2 ($4017) with fast binary ring-buffer savestates and CRC32 verification.

export const INPUT_BITS = {
  A: 1 << 0,
  B: 1 << 1,
  SELECT: 1 << 2,
  START: 1 << 3,
  UP: 1 << 4,
  DOWN: 1 << 5,
  LEFT: 1 << 6,
  RIGHT: 1 << 7
};

// Precomputed CRC32 table for fast ROM & deterministic RAM checksums
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

export function crc32Bytes(bytes, start = 0, length = bytes.length - start, seed = 0) {
  let crc = (seed ^ 0xffffffff) >>> 0;
  const end = start + length;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ (bytes[i] & 0xff)) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function computeRomCrc32(romBinaryStringOrUint8) {
  let crc = 0xffffffff;
  if (typeof romBinaryStringOrUint8 === 'string') {
    for (let i = 0; i < romBinaryStringOrUint8.length; i++) {
      const byte = romBinaryStringOrUint8.charCodeAt(i) & 0xff;
      crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  } else {
    for (let i = 0; i < romBinaryStringOrUint8.length; i++) {
      const byte = romBinaryStringOrUint8[i] & 0xff;
      crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export function formatHex32(val) {
  return (val >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

const CPU_SCALAR_PROPS = [
  'cyclesToHalt',
  'dataBus',
  'irqRequested',
  'irqType',
  'nmiRaised',
  'nmiPending',
  'nmiImmediate',
  'REG_ACC',
  'REG_X',
  'REG_Y',
  'REG_SP',
  'REG_PC',
  'REG_PC_NEW',
  'REG_STATUS',
  'F_CARRY',
  'F_DECIMAL',
  'F_INTERRUPT',
  'F_INTERRUPT_NEW',
  'F_OVERFLOW',
  'F_SIGN',
  'F_ZERO',
  'F_NOTUSED',
  'F_NOTUSED_NEW',
  'F_BRK',
  'F_BRK_NEW',
  '_cpuCycleBase',
  'instrBusCycles',
  'apuCatchupCycles',
  'nmiRaisedAtCycle',
  'nmiDotsRemainingInStep'
];

const PPU_SCALAR_PROPS = [
  'cntFV',
  'cntV',
  'cntH',
  'cntVT',
  'cntHT',
  'regFV',
  'regV',
  'regH',
  'regVT',
  'regHT',
  'regFH',
  'regS',
  'vramAddress',
  'vramTmpAddress',
  'f_nmiOnVblank',
  'f_spriteSize',
  'f_bgPatternTable',
  'f_spPatternTable',
  'f_addrInc',
  'f_nTblAddress',
  'f_color',
  'f_spVisibility',
  'f_bgVisibility',
  'f_spClipping',
  'f_bgClipping',
  'f_dispType',
  'vramBufferedReadValue',
  'firstWrite',
  'openBusLatch',
  'openBusDecayFrames',
  'currentMirroring',
  'sramAddress',
  'hitSpr0',
  'spr0HitX',
  'spr0HitY',
  'spritesFound',
  'sprite0InSecondary',
  'curX',
  'scanline',
  'lastRenderedScanline',
  'curNt',
  'nmiOutput',
  'nmiSuppressed',
  'vblankPending',
  'frameEnded',
  'dummyCycleToggle',
  'validTileData',
  'scanlineAlreadyRendered'
];

/**
 * Patches upstream jsnes v2.1.0 bug in 8x16 sprite rendering where odd-bank top tiles
 * subtracted 1 from an already-even topTileNum (`topTileNum - 1 + 256` -> `topTileNum + 256`).
 */
export function patchJsnes8x16Sprites(nes) {
  if (!nes || !nes.ppu) return;
  if (nes.rom && nes.rom.vromCount > 0 && Array.isArray(nes.rom.vromTile)) {
    for (let b = 0; b < nes.rom.vromTile.length; b++) {
      const bank = nes.rom.vromTile[b];
      if (!bank) continue;
      for (let t = 0; t < bank.length; t++) {
        if (bank[t]) bank[t]._vromRef = (b << 8) | (t & 0xff);
      }
    }
  }
  if (nes.ppu._patched8x16) return;
  const ppu = nes.ppu;
  ppu._patched8x16 = true;

  // Fix 1: Flush visible scanline background before HBlank ($2006/$2005/$2000) scroll changes
  // On real NES hardware, visible pixels are output during dots 0..255 and HUD split-screen IRQ
  // scroll writes happen in HBlank (dots 256..340) for the NEXT scanline. Because jsnes normally
  // waits until dot 341 (endScanline) to call renderBgScanline, HBlank scroll writes at dot ~335
  // would otherwise shift the current scanline and make bottom HUDs/menus jump by 1-2 scanlines.
  function flushCurrentScanlineIfHblank() {
    if (
      ppu.scanline >= 21 &&
      ppu.scanline <= 260 &&
      ppu.curX >= 256 &&
      !ppu.scanlineAlreadyRendered &&
      (ppu.f_bgVisibility === 1 || ppu.f_spVisibility === 1)
    ) {
      const bufferScan = ppu.scanline + 1 - 21;
      ppu.cntHT = ppu.regHT;
      ppu.cntH = ppu.regH;
      ppu.renderBgScanline(true, bufferScan);
      ppu.scanlineAlreadyRendered = true;
    }
  }

  const origWriteVRAMAddress = ppu.writeVRAMAddress.bind(ppu);
  ppu.writeVRAMAddress = function (address) {
    if (!this.firstWrite) {
      flushCurrentScanlineIfHblank();
      this.validTileData = false;
    }
    return origWriteVRAMAddress(address);
  };

  const origScrollWrite = ppu.scrollWrite.bind(ppu);
  ppu.scrollWrite = function (value) {
    flushCurrentScanlineIfHblank();
    return origScrollWrite(value);
  };

  // Fix 1b: Track per-tile dirty epochs on CHR-RAM pattern table writes ($0000-$1FFF)
  // so fast binary savestates only copy modified 8x8 tiles (e.g. Battletoads & Double Dragon Mapper 7).
  ppu._nextTileEpoch = 1;
  const origPatternWrite = ppu.patternWrite.bind(ppu);
  ppu.patternWrite = function (address, value) {
    const tileIndex = address >> 4;
    const t = this.ptTile && this.ptTile[tileIndex];
    if (t) {
      this._nextTileEpoch = (this._nextTileEpoch || 1) + 1;
      t._tileEpoch = this._nextTileEpoch;
    }
    return origPatternWrite(address, value);
  };

  // Fix 1c: Fast cached nametable mirroring switch (eliminates 56,192 loop iterations per HUD split
  // in AxROM Mapper 7 games like Battletoads & Double Dragon).
  ppu._mirrorCache = new Map();
  const origSetMirroring = ppu.setMirroring.bind(ppu);
  ppu.setMirroring = function (mirroring) {
    if (mirroring === this.currentMirroring) return;
    const cached = this._mirrorCache.get(mirroring);
    if (!cached) {
      origSetMirroring(mirroring);
      this._mirrorCache.set(mirroring, {
        vramSlice: this.vramMirrorTable.slice(0x2000, 0x3000),
        ntable1: [this.ntable1[0], this.ntable1[1], this.ntable1[2], this.ntable1[3]]
      });
      return;
    }
    this.currentMirroring = mirroring;
    this.triggerRendering();
    this.vramMirrorTable.set(cached.vramSlice, 0x2000);
    this.ntable1[0] = cached.ntable1[0];
    this.ntable1[1] = cached.ntable1[1];
    this.ntable1[2] = cached.ntable1[2];
    this.ntable1[3] = cached.ntable1[3];
  };

  // Fix 1d: True Headless PPU mode during intermediate rollback re-simulation frames (_headlessFrame = true).
  // Skips RGB framebuffer clears, OAM sprite pixel compositing, and border clipping while preserving
  // 100% of CPU/PPU scroll counters, Sprite-0 hit detection, and Mapper scanline IRQs.
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
    if (
      this._headlessFrame &&
      (!this.nes.rom ||
        (this.nes.rom.mapperType !== 9 &&
          this.nes.rom.mapperType !== 10 &&
          this.nes.rom.mapperType !== 5))
    ) {
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

  // Fix 1e: Native Uint8Array.set() PRG/CHR bank switching + redundant bank-switch deduplication
  const mmap = nes.mmap;
  if (mmap && !mmap._fastBankPatched) {
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
      if (address === 0x8000 && this._bankAt8000 === b0 && this._bankAtC000 === b1) {
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
      this.nes.cpu.mem.set(this.nes.rom.rom[bank16k].subarray(offset, offset + 8192), address);
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
      for (let i = 0; i < 256; i++) {
        ptTile[baseIndex + i] = vromTile[i];
      }
    };

    mmap.load1kVromBank = function (bank1k, address) {
      const vromCount = this.nes.rom ? this.nes.rom.vromCount : 0;
      if (vromCount === 0) return;
      this.nes.ppu.triggerRendering();
      const bank4k = Math.floor(bank1k / 4) % vromCount;
      const bankoffset = (bank1k % 4) * 1024;
      this.nes.ppu.vramMem.set(
        this.nes.rom.vrom[bank4k].subarray(bankoffset, bankoffset + 1024),
        address
      );
      const vromTile = this.nes.rom.vromTile[bank4k];
      const baseIndex = address >> 4;
      const tileOffset = (bank1k % 4) << 6;
      const ptTile = this.nes.ppu.ptTile;
      for (let i = 0; i < 64; i++) {
        ptTile[baseIndex + i] = vromTile[tileOffset + i];
      }
    };

    mmap.load2kVromBank = function (bank2k, address) {
      const vromCount = this.nes.rom ? this.nes.rom.vromCount : 0;
      if (vromCount === 0) return;
      this.nes.ppu.triggerRendering();
      const bank4k = Math.floor(bank2k / 2) % vromCount;
      const bankoffset = (bank2k % 2) * 2048;
      this.nes.ppu.vramMem.set(
        this.nes.rom.vrom[bank4k].subarray(bankoffset, bankoffset + 2048),
        address
      );
      const vromTile = this.nes.rom.vromTile[bank4k];
      const baseIndex = address >> 4;
      const tileOffset = (bank2k % 2) << 7;
      const ptTile = this.nes.ppu.ptTile;
      for (let i = 0; i < 128; i++) {
        ptTile[baseIndex + i] = vromTile[tileOffset + i];
      }
    };
  }

  // Fix 2: 8x16 sprite rendering (fix odd-bank topTileNum + 256 without double-flipping vertFlip rows)
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
          const tileIndex = this.f_spPatternTable === 0 ? sprTile : sprTile + 256;
          const sprBaseAddr = this.f_spPatternTable === 0 ? 0x0000 : 0x1000;
          const dy = sprY + 1;
          const fineY = scan - dy;
          if (fineY < 0 || fineY >= 8) continue;

          const t = mmap.getSpritePatternTile ? mmap.getSpritePatternTile(tileIndex) : ptTile[tileIndex];
          if (t) {
            t.render(
              buffer,
              0,
              fineY,
              8,
              fineY + 1,
              sprX,
              dy,
              palAdd,
              sprPalette,
              horiFlip,
              vertFlip,
              i,
              pixrendered
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

          let tileOffset;
          let tileFineY;
          if (fineY < 8) {
            tileOffset = vertFlip ? 1 : 0;
            tileFineY = fineY;
          } else {
            tileOffset = vertFlip ? 0 : 1;
            tileFineY = fineY - 8;
          }

          const t = mmap.getSpritePatternTile
            ? mmap.getSpritePatternTile(top + tileOffset)
            : ptTile[top + tileOffset];
          if (t) {
            t.render(
              buffer,
              0,
              tileFineY,
              8,
              tileFineY + 1,
              sprX,
              dy + (fineY < 8 ? 0 : 8),
              palAdd,
              sprPalette,
              horiFlip,
              vertFlip,
              i,
              pixrendered
            );
          }
          mmap.latchAccess(sprBaseAddr + topTileNum * 16 + 8);
          mmap.latchAccess(sprBaseAddr + (topTileNum + 1) * 16 + 8);
        }
      }
    }
  };
}

/**
 * Pre-allocated snapshot slot for zero-GC fast binary savestates.
 */
function createFastSnapshotSlot() {
  return {
    frame: -1,
    cpuMem: new Uint8Array(0x10000),
    cpuScalars: new Array(CPU_SCALAR_PROPS.length),
    vramMem: new Uint8Array(0x8000),
    spriteMem: new Uint8Array(0x100),
    vramMirrorSlice2k: new Uint16Array(0x1000),
    ntable1: [0, 0, 0, 0],
    ntTile: [
      new Uint8Array(1024),
      new Uint8Array(1024),
      new Uint8Array(1024),
      new Uint8Array(1024)
    ],
    ntAttrib: [
      new Uint8Array(1024),
      new Uint8Array(1024),
      new Uint8Array(1024),
      new Uint8Array(1024)
    ],
    ptTileRefs: new Array(512),
    scantileRefs: new Array(32),
    attrib: new Int32Array(32),
    hasChrRam: false,
    chrRamTileEpochs: new Uint32Array(512),
    chrRamPix: new Uint8Array(512 * 64),
    chrRamOpaque: new Uint8Array(512 * 8),
    sprPalette: new Uint32Array(16),
    imgPalette: new Uint32Array(16),
    secondaryOAM: new Uint8Array(32),
    scanlineSpriteCount: new Uint8Array(241),
    scanlineSecondaryOAM: new Uint8Array(241 * 32),
    scanlineSprite0: new Uint8Array(241),
    ppuScalars: new Array(PPU_SCALAR_PROPS.length),
    mmapState: null,
    papuState: null,
    ctrl1State: null,
    ctrl2State: null
  };
}

export function saveFastState(nes, slot, frameNum = 0) {
  slot.frame = frameNum;
  const cpu = nes.cpu;
  const ppu = nes.ppu;

  slot.cpuMem.set(cpu.mem);
  for (let i = 0; i < CPU_SCALAR_PROPS.length; i++) {
    slot.cpuScalars[i] = cpu[CPU_SCALAR_PROPS[i]];
  }

  slot.vramMem.set(ppu.vramMem);
  slot.spriteMem.set(ppu.spriteMem);
  slot.vramMirrorSlice2k.set(ppu.vramMirrorTable.subarray(0x2000, 0x3000));
  for (let i = 0; i < 4; i++) {
    slot.ntable1[i] = ppu.ntable1[i];
    slot.ntTile[i].set(ppu.nameTable[i].tile);
    slot.ntAttrib[i].set(ppu.nameTable[i].attrib);
  }

  const hasChrRam = !nes.rom || nes.rom.vromCount === 0;
  slot.hasChrRam = hasChrRam;
  for (let i = 0; i < 512; i++) {
    const t = ppu.ptTile[i];
    slot.ptTileRefs[i] = t;
    if (hasChrRam && t) {
      const epoch = t._tileEpoch || 1;
      if (slot.chrRamTileEpochs[i] !== epoch) {
        slot.chrRamTileEpochs[i] = epoch;
        slot.chrRamPix.set(t.pix, i * 64);
        slot.chrRamOpaque.set(t.opaque, i * 8);
      }
    }
  }

  for (let i = 0; i < 32; i++) {
    slot.scantileRefs[i] = ppu.scantile ? ppu.scantile[i] : undefined;
    slot.attrib[i] = ppu.attrib ? ppu.attrib[i] : 0;
  }

  slot.sprPalette.set(ppu.sprPalette);
  slot.imgPalette.set(ppu.imgPalette);
  slot.secondaryOAM.set(ppu.secondaryOAM);
  slot.scanlineSpriteCount.set(ppu.scanlineSpriteCount);
  slot.scanlineSecondaryOAM.set(ppu.scanlineSecondaryOAM);
  slot.scanlineSprite0.set(ppu.scanlineSprite0);

  for (let i = 0; i < PPU_SCALAR_PROPS.length; i++) {
    slot.ppuScalars[i] = ppu[PPU_SCALAR_PROPS[i]];
  }

  slot.mmapState = nes.mmap ? nes.mmap.toJSON() : null;
  slot.papuState = nes.papu ? nes.papu.toJSON() : null;
  slot.ctrl1State = nes.controllers[1].toJSON();
  slot.ctrl2State = nes.controllers[2].toJSON();
}

export function loadFastState(nes, slot) {
  const cpu = nes.cpu;
  const ppu = nes.ppu;

  if (nes.mmap && slot.mmapState) {
    nes.mmap.fromJSON(slot.mmapState);
  }
  if (nes.mmap) {
    nes.mmap._bankAt8000 = -1;
    nes.mmap._bankAtC000 = -1;
  }

  cpu.mem.set(slot.cpuMem);
  for (let i = 0; i < CPU_SCALAR_PROPS.length; i++) {
    cpu[CPU_SCALAR_PROPS[i]] = slot.cpuScalars[i];
  }

  ppu.vramMem.set(slot.vramMem);
  ppu.spriteMem.set(slot.spriteMem);
  ppu.vramMirrorTable.set(slot.vramMirrorSlice2k, 0x2000);
  for (let i = 0; i < 4; i++) {
    ppu.ntable1[i] = slot.ntable1[i];
    ppu.nameTable[i].tile.set(slot.ntTile[i]);
    ppu.nameTable[i].attrib.set(slot.ntAttrib[i]);
  }

  for (let i = 0; i < 512; i++) {
    ppu.ptTile[i] = slot.ptTileRefs[i];
    if (slot.hasChrRam && ppu.ptTile[i]) {
      const t = ppu.ptTile[i];
      const savedEpoch = slot.chrRamTileEpochs[i];
      if ((t._tileEpoch || 1) !== savedEpoch) {
        t._tileEpoch = savedEpoch;
        t.pix.set(slot.chrRamPix.subarray(i * 64, (i + 1) * 64));
        t.opaque.set(slot.chrRamOpaque.subarray(i * 8, (i + 1) * 8));
      }
    }
  }

  if (ppu.scantile && ppu.attrib) {
    for (let i = 0; i < 32; i++) {
      ppu.scantile[i] = slot.scantileRefs[i];
      ppu.attrib[i] = slot.attrib[i];
    }
  }

  ppu.sprPalette.set(slot.sprPalette);
  ppu.imgPalette.set(slot.imgPalette);
  ppu.secondaryOAM.set(slot.secondaryOAM);
  ppu.scanlineSpriteCount.set(slot.scanlineSpriteCount);
  ppu.scanlineSecondaryOAM.set(slot.scanlineSecondaryOAM);
  ppu.scanlineSprite0.set(slot.scanlineSprite0);

  for (let i = 0; i < PPU_SCALAR_PROPS.length; i++) {
    ppu[PPU_SCALAR_PROPS[i]] = slot.ppuScalars[i];
  }

  for (let i = 0; i < 256; i++) {
    ppu.spriteRamWriteUpdate(i, ppu.spriteMem[i]);
  }

  if (nes.papu && slot.papuState) {
    nes.papu.fromJSON(slot.papuState);
  }
  if (slot.ctrl1State) {
    nes.controllers[1].fromJSON(slot.ctrl1State);
  }
  if (slot.ctrl2State) {
    nes.controllers[2].fromJSON(slot.ctrl2State);
  }
}

/**
 * Applies an 8-bit controller bitmask directly to jsnes controller 1 or 2.
 */
export function applyControllerMask(nes, controllerIdx, mask) {
  const ctrl = nes.controllers[controllerIdx];
  if (!ctrl) return;
  ctrl.turboA = false;
  ctrl.turboB = false;
  ctrl.state[0] = (mask & INPUT_BITS.A) !== 0 ? 0x41 : 0x40;
  ctrl.state[1] = (mask & INPUT_BITS.B) !== 0 ? 0x41 : 0x40;
  ctrl.state[2] = (mask & INPUT_BITS.SELECT) !== 0 ? 0x41 : 0x40;
  ctrl.state[3] = (mask & INPUT_BITS.START) !== 0 ? 0x41 : 0x40;
  ctrl.state[4] = (mask & INPUT_BITS.UP) !== 0 ? 0x41 : 0x40;
  ctrl.state[5] = (mask & INPUT_BITS.DOWN) !== 0 ? 0x41 : 0x40;
  ctrl.state[6] = (mask & INPUT_BITS.LEFT) !== 0 ? 0x41 : 0x40;
  ctrl.state[7] = (mask & INPUT_BITS.RIGHT) !== 0 ? 0x41 : 0x40;
  ctrl.baseA = ctrl.state[0];
  ctrl.baseB = ctrl.state[1];
}

/**
 * Computes a deterministic 32-bit CRC32 of NES 2KB CPU RAM ($0000-$07FF),
 * CPU registers (PC, A, X, Y, SP), and PPU nametable/palette VRAM ($2000-$3FFF).
 */
export function computeDeterministicHash(nes) {
  let crc = crc32Bytes(nes.cpu.mem, 0, 0x0800, 0);
  const regBytes = new Uint8Array([
    nes.cpu.REG_PC & 0xff,
    (nes.cpu.REG_PC >> 8) & 0xff,
    nes.cpu.REG_ACC & 0xff,
    nes.cpu.REG_X & 0xff,
    nes.cpu.REG_Y & 0xff,
    nes.cpu.REG_SP & 0xff
  ]);
  crc = crc32Bytes(regBytes, 0, regBytes.length, crc);
  crc = crc32Bytes(nes.ppu.vramMem, 0x2000, 0x2000, crc);
  return crc >>> 0;
}

export class NesNetplayEngine {
  constructor(nes, options = {}) {
    this.nes = nes;
    patchJsnes8x16Sprites(this.nes);

    this.localPlayer = options.localPlayer || 1; // 1 = Controller 1 ($4016), 2 = Controller 2 ($4017)
    this.online = Boolean(options.online);
    this.inputDelayFrames = options.inputDelayFrames ?? 2;
    this.maxRollbackFrames = options.maxRollbackFrames ?? 20;
    this.enableRiftPacing = Boolean(options.enableRiftPacing);
    this.historySize = 256;
    this.saveBufferSize = options.saveBufferSize ?? 64;
    this.sessionId = options.sessionId || 'default';
    this.syncPaused = false;

    // Hook nes.opts.onAudioSample and nes.opts.onFrame so we can suppress duplicate audio/video during rollback re-simulation
    this.suppressCallbacks = false;
    this._wrapNesCallbacks();

    this.saveRing = new Array(this.saveBufferSize);
    for (let i = 0; i < this.saveBufferSize; i++) {
      this.saveRing[i] = createFastSnapshotSlot();
    }

    this.resetTimeline(0);
  }

  _wrapNesCallbacks() {
    if (!this.nes || !this.nes.opts || this.nes._netplayWrapped) return;
    this.nes._netplayWrapped = true;
    const origFrame = this.nes.opts.onFrame;
    const origAudio = this.nes.opts.onAudioSample;

    this.nes.opts.onFrame = (fb) => {
      if (!this.suppressCallbacks && origFrame) {
        origFrame(fb);
      }
    };
    this.nes.opts.onAudioSample = (l, r) => {
      if (!this.suppressCallbacks && origAudio) {
        origAudio(l, r);
      }
    };
  }

  resetTimeline(startFrame = 0, newSessionId = null) {
    if (newSessionId) {
      this.sessionId = newSessionId;
    }
    this.timelineStartFrame = startFrame;
    this.currentFrame = startFrame;
    this.p1Inputs = new Uint8Array(this.historySize);
    this.p2Inputs = new Uint8Array(this.historySize);
    this.p1Confirmed = new Int32Array(this.historySize).fill(-1);
    this.p2Confirmed = new Int32Array(this.historySize).fill(-1);

    // Exact masks passed to applyControllerMask when each frame was last simulated
    this.p1Simulated = new Uint8Array(this.historySize);
    this.p2Simulated = new Uint8Array(this.historySize);
    this.simulatedFrameTag = new Int32Array(this.historySize).fill(-1);

    this.lastConfirmedRemoteFrame = startFrame - 1;
    this.lastLocalScheduledFrame = startFrame - 1;
    this.earliestMispredictedFrame = null;

    // Seed initial delay frames (startFrame .. startFrame + inputDelayFrames - 1) with neutral 0 input for both players
    for (let f = startFrame; f < startFrame + this.inputDelayFrames; f++) {
      const idx = f % this.historySize;
      this.p1Inputs[idx] = 0;
      this.p2Inputs[idx] = 0;
      this.p1Confirmed[idx] = f;
      this.p2Confirmed[idx] = f;
    }
    if (this.inputDelayFrames > 0) {
      this.lastConfirmedRemoteFrame = startFrame + this.inputDelayFrames - 1;
      this.lastLocalScheduledFrame = startFrame + this.inputDelayFrames - 1;
    }

    // Checksum tracking (frame -> uint32 hash)
    this.localHashes = new Map();
    this.remoteHashes = new Map();
    this.syncStatus = 'SYNC_OK'; // 'SYNC_OK' | 'DESYNC'
    this.lastVerifiedFrame = -1;
    this.lastLocalHash = 0;
    this.lastRemoteHash = 0;
    this.desyncCount = 0;

    // Telemetry
    this.rollbacksTotal = 0;
    this.rollbacksThisSec = 0;
    this.rollbacksPerSec = 0;
    this.lastRollbackSecTick = Date.now();
    this.lastRollbackDepth = 0;
    this.maxRollbackDepthSeen = 0;
    this.stallFrames = 0;
    this.riftFrames = 0;
    this.riftWaitFrames = 0;
    this._riftCooldown = 0;
    this.lastStepMs = 0;

    for (let i = 0; i < this.saveBufferSize; i++) {
      this.saveRing[i].frame = -1;
      this.saveRing[i].chrRamTileEpochs.fill(0);
    }
    if (this.nes && this.nes.mmap) {
      this.nes.mmap._bankAt8000 = -1;
      this.nes.mmap._bankAtC000 = -1;
      saveFastState(this.nes, this.saveRing[startFrame % this.saveBufferSize], startFrame);
    }
  }

  static computeRecommendedInputDelay(rttMs, jitterMs = 0) {
    if (!Number.isFinite(rttMs) || rttMs <= 0) return 3;
    const effectiveRtt = rttMs + Math.min(40, Math.max(0, jitterMs) * 0.5);
    if (effectiveRtt <= 85) return 2;
    if (effectiveRtt <= 165) return 3;
    if (effectiveRtt <= 250) return 4;
    return 5;
  }

  setInputDelay(frames) {
    const nextDelay = Math.max(0, Math.min(8, Math.floor(frames)));
    if (nextDelay === this.inputDelayFrames) return;
    const targetNew = this.currentFrame + nextDelay - 1;
    const prevMask = this.getLocalInputAt(Math.max(this.timelineStartFrame, this.lastLocalScheduledFrame));
    while (this.lastLocalScheduledFrame < targetNew) {
      this.lastLocalScheduledFrame++;
      this._setPlayerInput(this.localPlayer, this.lastLocalScheduledFrame, prevMask, true);
    }
    this.inputDelayFrames = nextDelay;
  }

  _setPlayerInput(playerNum, frame, mask, confirmed) {
    const idx = frame % this.historySize;
    if (playerNum === 1) {
      this.p1Inputs[idx] = mask & 0xff;
      if (confirmed) this.p1Confirmed[idx] = frame;
    } else {
      this.p2Inputs[idx] = mask & 0xff;
      if (confirmed) this.p2Confirmed[idx] = frame;
    }
  }

  getPlayerInput(playerNum, frame) {
    if (frame < 0) return 0;
    const idx = frame % this.historySize;
    if (playerNum === 1) {
      if (this.p1Confirmed[idx] === frame) return this.p1Inputs[idx];
      // Predict from last confirmed P1 frame
      if (this.lastConfirmedRemoteFrame >= this.timelineStartFrame && this.localPlayer === 2) {
        return this.p1Inputs[this.lastConfirmedRemoteFrame % this.historySize];
      }
      return 0;
    } else {
      if (this.p2Confirmed[idx] === frame) return this.p2Inputs[idx];
      // Predict from last confirmed P2 frame
      if (this.lastConfirmedRemoteFrame >= this.timelineStartFrame && this.localPlayer === 1) {
        return this.p2Inputs[this.lastConfirmedRemoteFrame % this.historySize];
      }
      return 0;
    }
  }

  getLocalInputAt(frame) {
    return this.getPlayerInput(this.localPlayer, frame);
  }

  /**
   * Called when remote input packet arrives:
   * packet = { startFrame, inputs: [mask_start, mask_{start-1}, ...], sessionId?, hashFrame?, hash? }
   */
  receiveRemoteInputPacket(packet) {
    if (!packet || typeof packet.startFrame !== 'number' || !Array.isArray(packet.inputs)) {
      return;
    }
    if (packet.sessionId && this.sessionId && packet.sessionId !== this.sessionId) {
      return;
    }
    const remotePlayer = this.localPlayer === 1 ? 2 : 1;
    const confirmedArr = remotePlayer === 1 ? this.p1Confirmed : this.p2Confirmed;
    const inputsArr = remotePlayer === 1 ? this.p1Inputs : this.p2Inputs;
    const simulatedArr = remotePlayer === 1 ? this.p1Simulated : this.p2Simulated;
    const minValidFrame = Math.max(
      this.timelineStartFrame,
      this.currentFrame - (this.saveBufferSize - 4)
    );

    // Process from oldest to newest in the redundant window (expanding RLE tailCount if present)
    const rawLen = packet.inputs.length;
    if (rawLen === 0) return;
    const totalLen = Math.max(rawLen, packet.tailCount || 0);
    const tailVal = packet.inputs[rawLen - 1] & 0xff;
    for (let i = totalLen - 1; i >= 0; i--) {
      const f = packet.startFrame - i;
      if (f < minValidFrame) continue;

      const mask = i < rawLen ? (packet.inputs[i] & 0xff) : tailVal;
      const idx = f % this.historySize;
      const wasConfirmed = confirmedArr[idx] === f;

      if (!wasConfirmed) {
        // Check against the exact mask that was used when frame f was last simulated
        if (f < this.currentFrame && this.simulatedFrameTag[idx] === f) {
          const usedMask = simulatedArr[idx];
          if (usedMask !== mask) {
            if (
              this.earliestMispredictedFrame === null ||
              f < this.earliestMispredictedFrame
            ) {
              this.earliestMispredictedFrame = f;
            }
          }
        }
        inputsArr[idx] = mask;
        confirmedArr[idx] = f;
        if (f > this.lastConfirmedRemoteFrame) {
          this.lastConfirmedRemoteFrame = f;
        }
      }
    }

    // Update GGPO Clock-Rift estimate: riftFrames = (myLead - peerLead) * 0.5
    if (typeof packet.peerLead === 'number' && Number.isFinite(packet.peerLead)) {
      const myLead =
        this.currentFrame - Math.max(this.timelineStartFrame, this.lastConfirmedRemoteFrame);
      const sampleRift = (myLead - packet.peerLead) * 0.5;
      this.riftFrames = Number((this.riftFrames * 0.7 + sampleRift * 0.3).toFixed(2));
    }

    // Check deterministic hash if included
    if (
      typeof packet.hashFrame === 'number' &&
      typeof packet.hash === 'number' &&
      packet.hashFrame >= this.timelineStartFrame
    ) {
      this.remoteHashes.set(packet.hashFrame, packet.hash >>> 0);
      this._cleanupOldHashes();
    }
  }

  _cleanupOldHashes() {
    while (this.localHashes.size > 40) {
      const oldest = this.localHashes.keys().next().value;
      this.localHashes.delete(oldest);
    }
    while (this.remoteHashes.size > 40) {
      const oldest = this.remoteHashes.keys().next().value;
      this.remoteHashes.delete(oldest);
    }
  }

  _verifyConfirmedHashes() {
    if (this.earliestMispredictedFrame !== null) return;
    for (const [frame, remoteHash] of this.remoteHashes.entries()) {
      if (frame <= this.lastConfirmedRemoteFrame && frame <= this.currentFrame && this.localHashes.has(frame)) {
        if (frame > this.lastVerifiedFrame) {
          const localHash = this.localHashes.get(frame);
          this.lastVerifiedFrame = frame;
          this.lastLocalHash = localHash;
          this.lastRemoteHash = remoteHash;
          if (localHash === remoteHash) {
            this.syncStatus = 'SYNC_OK';
          } else {
            this.syncStatus = 'DESYNC';
            this.desyncCount++;
          }
        }
      }
    }
  }

  /**
   * Executes any pending rollback, then steps 1 frame (or stalls if waiting for remote beyond maxRollbackFrames).
   * Returns { stepped: boolean, packetToSend: object | null, p1Mask: number, p2Mask: number }
   */
  stepNetplayFrame(localButtonsMask, p2LocalButtonsMask = 0) {
    const t0 = performance.now();
    const now = Date.now();
    if (now - this.lastRollbackSecTick >= 1000) {
      this.rollbacksPerSec = this.rollbacksThisSec;
      this.rollbacksThisSec = 0;
      this.lastRollbackSecTick = now;
    }

    if (this.syncPaused) {
      return {
        stepped: false,
        stalled: true,
        syncPaused: true,
        packetToSend: null,
        p1Mask: 0,
        p2Mask: 0
      };
    }

    if (!this.online) {
      // Offline / Solo or Local 2P mode: direct immediate stepping
      const f = this.currentFrame;
      const idx = f % this.historySize;
      this._setPlayerInput(1, f, localButtonsMask, true);
      this._setPlayerInput(2, f, p2LocalButtonsMask, true);
      this.p1Simulated[idx] = localButtonsMask & 0xff;
      this.p2Simulated[idx] = p2LocalButtonsMask & 0xff;
      this.simulatedFrameTag[idx] = f;
      this.lastConfirmedRemoteFrame = f;
      this.lastLocalScheduledFrame = f;
      saveFastState(this.nes, this.saveRing[f % this.saveBufferSize], f);
      applyControllerMask(this.nes, 1, localButtonsMask);
      applyControllerMask(this.nes, 2, p2LocalButtonsMask);
      this.suppressCallbacks = false;
      this.nes.frame();
      this.currentFrame++;
      this.lastStepMs = performance.now() - t0;
      return {
        stepped: true,
        stalled: false,
        packetToSend: null,
        p1Mask: localButtonsMask,
        p2Mask: p2LocalButtonsMask
      };
    }

    // 1. Find earliest frame < currentFrame whose desired (P1, P2) input differs from what was simulated
    const minRollbackFrame = Math.max(
      this.timelineStartFrame,
      this.currentFrame - (this.saveBufferSize - 4)
    );
    let rbFrame =
      this.earliestMispredictedFrame !== null &&
      this.earliestMispredictedFrame < this.currentFrame
        ? Math.max(minRollbackFrame, this.earliestMispredictedFrame)
        : null;
    this.earliestMispredictedFrame = null;

    for (let f = minRollbackFrame; f < this.currentFrame; f++) {
      if (rbFrame !== null && f >= rbFrame) break;
      const idx = f % this.historySize;
      if (this.simulatedFrameTag[idx] === f) {
        const want1 = this.getPlayerInput(1, f);
        const want2 = this.getPlayerInput(2, f);
        if (want1 !== this.p1Simulated[idx] || want2 !== this.p2Simulated[idx]) {
          rbFrame = f;
          break;
        }
      }
    }

    if (rbFrame !== null && rbFrame < this.currentFrame) {
      const slot = this.saveRing[rbFrame % this.saveBufferSize];
      if (slot && slot.frame === rbFrame) {
        const depth = this.currentFrame - rbFrame;
        this.rollbacksTotal++;
        this.rollbacksThisSec++;
        this.lastRollbackDepth = depth;
        if (depth > this.maxRollbackDepthSeen) {
          this.maxRollbackDepthSeen = depth;
        }

        // Restore state at rbFrame and re-simulate rbFrame .. currentFrame - 1 in silent/headless mode
        loadFastState(this.nes, slot);
        this.suppressCallbacks = true;
        this.nes.ppu._headlessFrame = true;
        for (let f = rbFrame; f < this.currentFrame; f++) {
          if (f > rbFrame) {
            saveFastState(this.nes, this.saveRing[f % this.saveBufferSize], f);
          }
          const m1 = this.getPlayerInput(1, f);
          const m2 = this.getPlayerInput(2, f);
          const idx = f % this.historySize;
          this.p1Simulated[idx] = m1;
          this.p2Simulated[idx] = m2;
          this.simulatedFrameTag[idx] = f;
          applyControllerMask(this.nes, 1, m1);
          applyControllerMask(this.nes, 2, m2);
          this.nes.frame();

          // Recompute local hash at checkpoints during rollback re-simulation
          if ((f + 1) % 30 === 0) {
            this.localHashes.set(f + 1, computeDeterministicHash(this.nes));
          }
        }
        this.nes.ppu._headlessFrame = false;
        this.suppressCallbacks = false;
      }
    }

    // 2. Check if we are ahead of remote player by more than maxRollbackFrames
    const framesAhead = this.currentFrame - this.lastConfirmedRemoteFrame;
    if (framesAhead > this.maxRollbackFrames) {
      // Rift stall: wait for remote input packet, but still broadcast our latest inputs so peer isn't deadlocked
      this.stallFrames++;
      this._verifyConfirmedHashes();
      const packetToSend = this._buildInputPacket(this.lastLocalScheduledFrame);
      this.lastStepMs = performance.now() - t0;
      return {
        stepped: false,
        stalled: true,
        packetToSend,
        p1Mask: this.getPlayerInput(1, Math.max(this.timelineStartFrame, this.currentFrame - 1)),
        p2Mask: this.getPlayerInput(2, Math.max(this.timelineStartFrame, this.currentFrame - 1))
      };
    }

    // 2b. GGPO Clock-Rift / Frame-Advantage Pacing:
    // If our clock has drifted > 1.75 frames ahead of peer's clock, gently hold 1 frame
    // every 4-10 frames so both PCs stay balanced around riftFrames ≈ 0 without hitting hard stalls.
    if (this.enableRiftPacing && this.riftFrames > 1.75) {
      const cooldownTarget = this.riftFrames > 5 ? 4 : 10;
      if (this._riftCooldown >= cooldownTarget) {
        this._riftCooldown = 0;
        this.riftWaitFrames++;
        this._verifyConfirmedHashes();
        const packetToSend = this._buildInputPacket(this.lastLocalScheduledFrame);
        this.lastStepMs = performance.now() - t0;
        return {
          stepped: false,
          stalled: false,
          riftPaced: true,
          packetToSend,
          p1Mask: this.getPlayerInput(1, Math.max(this.timelineStartFrame, this.currentFrame - 1)),
          p2Mask: this.getPlayerInput(2, Math.max(this.timelineStartFrame, this.currentFrame - 1))
        };
      }
      this._riftCooldown++;
    } else {
      this._riftCooldown = 0;
    }

    // 3. Schedule local input at (currentFrame + inputDelayFrames) without overwriting already-sent frames
    const targetInputFrame = Math.max(
      this.lastLocalScheduledFrame + 1,
      this.currentFrame + this.inputDelayFrames
    );
    while (this.lastLocalScheduledFrame < targetInputFrame) {
      this.lastLocalScheduledFrame++;
      this._setPlayerInput(this.localPlayer, this.lastLocalScheduledFrame, localButtonsMask, true);
    }

    // 4. Save snapshot before stepping currentFrame
    const f = this.currentFrame;
    const idx = f % this.historySize;
    saveFastState(this.nes, this.saveRing[f % this.saveBufferSize], f);

    // 5. Step currentFrame with P1 and P2 inputs (confirmed or predicted)
    const p1Mask = this.getPlayerInput(1, f);
    const p2Mask = this.getPlayerInput(2, f);
    this.p1Simulated[idx] = p1Mask;
    this.p2Simulated[idx] = p2Mask;
    this.simulatedFrameTag[idx] = f;
    applyControllerMask(this.nes, 1, p1Mask);
    applyControllerMask(this.nes, 2, p2Mask);
    this.suppressCallbacks = false;
    this.nes.frame();

    this.currentFrame++;

    // 6. Record deterministic hash after frame completes at every 30-frame boundary
    if (this.currentFrame % 30 === 0) {
      this.localHashes.set(this.currentFrame, computeDeterministicHash(this.nes));
      this._cleanupOldHashes();
    }
    this._verifyConfirmedHashes();

    const packetToSend = this._buildInputPacket(this.lastLocalScheduledFrame);
    this.lastStepMs = performance.now() - t0;

    return {
      stepped: true,
      stalled: false,
      packetToSend,
      p1Mask,
      p2Mask
    };
  }

  _buildInputPacket(latestScheduledFrame) {
    const available = Math.max(1, latestScheduledFrame - this.timelineStartFrame + 1);
    const count = Math.min(32, available);
    const fullInputs = new Array(count);
    for (let i = 0; i < count; i++) {
      fullInputs[i] = this.getLocalInputAt(latestScheduledFrame - i);
    }
    // Trim redundant identical tail values to keep packet size compact over WSS tunnels
    const tailVal = fullInputs[count - 1];
    let trimLen = count;
    while (trimLen > 1 && fullInputs[trimLen - 2] === tailVal) {
      trimLen--;
    }
    const inputs = trimLen < count ? fullInputs.slice(0, trimLen) : fullInputs;
    const pkt = {
      type: 'netplay_input',
      sessionId: this.sessionId,
      player: this.localPlayer,
      startFrame: latestScheduledFrame,
      peerLead: this.currentFrame - Math.max(this.timelineStartFrame, this.lastConfirmedRemoteFrame),
      inputs
    };
    if (trimLen < count) {
      pkt.tailCount = count;
    }
    // Attach most recent confirmed hash checkpoint (where both P1 and P2 inputs are confirmed)
    if (this.localHashes.size > 0 && this.earliestMispredictedFrame === null) {
      let latestConfirmedHashFrame = -1;
      for (const k of this.localHashes.keys()) {
        if (k <= this.lastConfirmedRemoteFrame && k <= this.currentFrame && k > latestConfirmedHashFrame) {
          latestConfirmedHashFrame = k;
        }
      }
      if (latestConfirmedHashFrame >= 0) {
        pkt.hashFrame = latestConfirmedHashFrame;
        pkt.hash = this.localHashes.get(latestConfirmedHashFrame);
      }
    }
    return pkt;
  }

  /**
   * Exports a compact portable state object (for initial room handshake or resync).
   */
  exportSyncState() {
    patchJsnes8x16Sprites(this.nes);
    const nesState = this.nes.toJSON();
    let ptTileMap = null;
    let scantileMap = null;
    if (this.nes.rom && this.nes.rom.vromCount > 0) {
      ptTileMap = new Array(512);
      for (let i = 0; i < 512; i++) {
        const t = this.nes.ppu.ptTile[i];
        ptTileMap[i] = t && typeof t._vromRef === 'number' ? t._vromRef : 0;
      }
      nesState.ppu.ptTile = [];

      scantileMap = new Array(32);
      for (let i = 0; i < 32; i++) {
        const st = this.nes.ppu.scantile ? this.nes.ppu.scantile[i] : null;
        scantileMap[i] = st && typeof st._vromRef === 'number' ? st._vromRef : -1;
      }
    }
    // Strip 184,320-int transient render buffers (~1.5 MB JSON) that are cleared on startFrame()
    delete nesState.ppu.buffer;
    delete nesState.ppu.bgbuffer;
    delete nesState.ppu.pixrendered;
    delete nesState.ppu.scantile;

    return {
      sessionId: this.sessionId,
      frame: this.currentFrame,
      inputDelayFrames: this.inputDelayFrames,
      nesState,
      ptTileMap,
      scantileMap,
      hash: computeDeterministicHash(this.nes)
    };
  }

  /**
   * Imports a portable state object and locks timeline to that exact frame and sessionId.
   */
  importSyncState(syncObj) {
    if (!syncObj || !syncObj.nesState) return false;
    patchJsnes8x16Sprites(this.nes);
    const s = syncObj.nesState;
    this.nes.mmap.fromJSON(s.mmap);
    this.nes.cpu.fromJSON(s.cpu);

    const ppu = this.nes.ppu;
    const useRefMap =
      this.nes.rom && this.nes.rom.vromCount > 0 && Array.isArray(syncObj.ptTileMap);
    const origPtTile = ppu.ptTile;
    const origScantile = ppu.scantile;
    const origBuffer = ppu.buffer;
    const origBgBuffer = ppu.bgbuffer;
    const origPixRendered = ppu.pixrendered;

    if (useRefMap) {
      ppu.ptTile = [];
    }
    ppu.fromJSON(s.ppu);

    // Restore transient render buffers preserved across fromJSON
    ppu.buffer = origBuffer;
    ppu.bgbuffer = origBgBuffer;
    ppu.pixrendered = origPixRendered;
    ppu.scantile = origScantile;

    if (useRefMap) {
      ppu.ptTile = origPtTile;
      for (let i = 0; i < 512; i++) {
        const ref = syncObj.ptTileMap[i] || 0;
        const b = (ref >> 8) & 0xff;
        const t = ref & 0xff;
        if (this.nes.rom.vromTile[b] && this.nes.rom.vromTile[b][t]) {
          ppu.ptTile[i] = this.nes.rom.vromTile[b][t];
        }
      }
      if (Array.isArray(syncObj.scantileMap) && ppu.scantile) {
        for (let i = 0; i < 32; i++) {
          const ref = syncObj.scantileMap[i];
          if (typeof ref === 'number' && ref >= 0) {
            const b = (ref >> 8) & 0xff;
            const t = ref & 0xff;
            ppu.scantile[i] =
              this.nes.rom.vromTile[b] && this.nes.rom.vromTile[b][t]
                ? this.nes.rom.vromTile[b][t]
                : undefined;
          } else {
            ppu.scantile[i] = undefined;
          }
        }
      }
    }

    this.nes.papu.fromJSON(s.papu);
    if (s.controllers) {
      if (s.controllers[1]) this.nes.controllers[1].fromJSON(s.controllers[1]);
      if (s.controllers[2]) this.nes.controllers[2].fromJSON(s.controllers[2]);
    }

    if (typeof syncObj.inputDelayFrames === 'number') {
      this.inputDelayFrames = syncObj.inputDelayFrames;
    }
    if (syncObj.sessionId) {
      this.sessionId = syncObj.sessionId;
    }
    this.resetTimeline(syncObj.frame || 0);
    return true;
  }

  getTelemetry() {
    return {
      currentFrame: this.currentFrame,
      lastConfirmedRemoteFrame: this.lastConfirmedRemoteFrame,
      frameAdvantage: this.currentFrame - Math.max(0, this.lastConfirmedRemoteFrame),
      riftFrames: this.riftFrames,
      riftWaitFrames: this.riftWaitFrames,
      inputDelayFrames: this.inputDelayFrames,
      maxRollbackFrames: this.maxRollbackFrames,
      rollbacksTotal: this.rollbacksTotal,
      rollbacksPerSec: this.rollbacksPerSec,
      lastRollbackDepth: this.lastRollbackDepth,
      maxRollbackDepthSeen: this.maxRollbackDepthSeen,
      stallFrames: this.stallFrames,
      syncStatus: this.syncStatus,
      lastVerifiedFrame: this.lastVerifiedFrame,
      lastLocalHash: formatHex32(this.lastLocalHash),
      lastRemoteHash: formatHex32(this.lastRemoteHash),
      desyncCount: this.desyncCount,
      lastStepMs: Number(this.lastStepMs.toFixed(2))
    };
  }
}
