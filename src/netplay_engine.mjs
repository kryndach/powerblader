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
    vramMirrorTable: new Uint16Array(0x8000),
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
    hasChrRam: false,
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
  slot.vramMirrorTable.set(ppu.vramMirrorTable);
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
      slot.chrRamPix.set(t.pix, i * 64);
      slot.chrRamOpaque.set(t.opaque, i * 8);
    }
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

  cpu.mem.set(slot.cpuMem);
  for (let i = 0; i < CPU_SCALAR_PROPS.length; i++) {
    cpu[CPU_SCALAR_PROPS[i]] = slot.cpuScalars[i];
  }

  ppu.vramMem.set(slot.vramMem);
  ppu.spriteMem.set(slot.spriteMem);
  ppu.vramMirrorTable.set(slot.vramMirrorTable);
  for (let i = 0; i < 4; i++) {
    ppu.ntable1[i] = slot.ntable1[i];
    ppu.nameTable[i].tile.set(slot.ntTile[i]);
    ppu.nameTable[i].attrib.set(slot.ntAttrib[i]);
  }

  for (let i = 0; i < 512; i++) {
    ppu.ptTile[i] = slot.ptTileRefs[i];
    if (slot.hasChrRam && ppu.ptTile[i]) {
      ppu.ptTile[i].pix.set(slot.chrRamPix.subarray(i * 64, (i + 1) * 64));
      ppu.ptTile[i].opaque.set(slot.chrRamOpaque.subarray(i * 8, (i + 1) * 8));
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

  if (nes.mmap && slot.mmapState) {
    nes.mmap.fromJSON(slot.mmapState);
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
    this.maxRollbackFrames = options.maxRollbackFrames ?? 12;
    this.historySize = 256;
    this.saveBufferSize = 32;

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

  resetTimeline(startFrame = 0) {
    this.currentFrame = startFrame;
    this.p1Inputs = new Uint8Array(this.historySize);
    this.p2Inputs = new Uint8Array(this.historySize);
    this.p1Confirmed = new Int32Array(this.historySize).fill(-1);
    this.p2Confirmed = new Int32Array(this.historySize).fill(-1);

    this.lastConfirmedRemoteFrame = startFrame - 1;
    this.earliestMispredictedFrame = null;

    // Seed initial delay frames (0 .. inputDelayFrames - 1) with neutral 0 input for both players
    for (let f = startFrame; f < startFrame + this.inputDelayFrames; f++) {
      const idx = f % this.historySize;
      this.p1Inputs[idx] = 0;
      this.p2Inputs[idx] = 0;
      this.p1Confirmed[idx] = f;
      this.p2Confirmed[idx] = f;
    }
    if (this.inputDelayFrames > 0) {
      this.lastConfirmedRemoteFrame = startFrame + this.inputDelayFrames - 1;
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
    this.lastStepMs = 0;

    for (let i = 0; i < this.saveBufferSize; i++) {
      this.saveRing[i].frame = -1;
    }
    if (this.nes && this.nes.mmap) {
      saveFastState(this.nes, this.saveRing[startFrame % this.saveBufferSize], startFrame);
    }
  }

  setInputDelay(frames) {
    const nextDelay = Math.max(0, Math.min(8, Math.floor(frames)));
    if (nextDelay === this.inputDelayFrames) return;
    // Seed any newly added delay frames with the last known local input
    const targetOld = this.currentFrame + this.inputDelayFrames;
    const targetNew = this.currentFrame + nextDelay;
    const prevMask = this.getLocalInputAt(Math.max(0, targetOld - 1));
    for (let f = targetOld; f < targetNew; f++) {
      this._setPlayerInput(this.localPlayer, f, prevMask, true);
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
      if (this.lastConfirmedRemoteFrame >= 0 && this.localPlayer === 2) {
        return this.p1Inputs[this.lastConfirmedRemoteFrame % this.historySize];
      }
      return this.p1Inputs[idx];
    } else {
      if (this.p2Confirmed[idx] === frame) return this.p2Inputs[idx];
      // Predict from last confirmed P2 frame
      if (this.lastConfirmedRemoteFrame >= 0 && this.localPlayer === 1) {
        return this.p2Inputs[this.lastConfirmedRemoteFrame % this.historySize];
      }
      return this.p2Inputs[idx];
    }
  }

  getLocalInputAt(frame) {
    return this.getPlayerInput(this.localPlayer, frame);
  }

  /**
   * Called when remote input packet arrives:
   * packet = { startFrame, inputs: [mask_start, mask_{start-1}, ...], hashFrame?, hash? }
   */
  receiveRemoteInputPacket(packet) {
    if (!packet || typeof packet.startFrame !== 'number' || !Array.isArray(packet.inputs)) {
      return;
    }
    const remotePlayer = this.localPlayer === 1 ? 2 : 1;
    const confirmedArr = remotePlayer === 1 ? this.p1Confirmed : this.p2Confirmed;
    const inputsArr = remotePlayer === 1 ? this.p1Inputs : this.p2Inputs;

    // Process from oldest to newest in the redundant window
    for (let i = packet.inputs.length - 1; i >= 0; i--) {
      const f = packet.startFrame - i;
      if (f < 0) continue;
      // Ignore frames way behind our rollback buffer
      if (f < this.currentFrame - (this.saveBufferSize - 2)) continue;

      const mask = packet.inputs[i] & 0xff;
      const idx = f % this.historySize;
      const wasConfirmed = confirmedArr[idx] === f;

      if (!wasConfirmed) {
        // If we already simulated frame f with a predicted input, check if our prediction matched
        if (f < this.currentFrame) {
          const predictedMask = this.getPlayerInput(remotePlayer, f);
          if (predictedMask !== mask) {
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

    // Check deterministic hash if included
    if (typeof packet.hashFrame === 'number' && typeof packet.hash === 'number') {
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

    if (!this.online) {
      // Offline / Solo or Local 2P mode: direct immediate stepping
      const f = this.currentFrame;
      this._setPlayerInput(1, f, localButtonsMask, true);
      this._setPlayerInput(2, f, p2LocalButtonsMask, true);
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

    // 1. Perform rollback if any earlier frame had a mispredicted remote input
    if (
      this.earliestMispredictedFrame !== null &&
      this.earliestMispredictedFrame < this.currentFrame
    ) {
      const rbFrame = this.earliestMispredictedFrame;
      this.earliestMispredictedFrame = null;
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
        for (let f = rbFrame; f < this.currentFrame; f++) {
          saveFastState(this.nes, this.saveRing[f % this.saveBufferSize], f);
          const m1 = this.getPlayerInput(1, f);
          const m2 = this.getPlayerInput(2, f);
          applyControllerMask(this.nes, 1, m1);
          applyControllerMask(this.nes, 2, m2);
          this.nes.frame();

          // Recompute local hash at checkpoints during rollback re-simulation
          if ((f + 1) % 30 === 0) {
            this.localHashes.set(f + 1, computeDeterministicHash(this.nes));
          }
        }
        this.suppressCallbacks = false;
      }
    }

    // 2. Check if we are ahead of remote player by more than maxRollbackFrames
    const framesAhead = this.currentFrame - this.lastConfirmedRemoteFrame;
    if (framesAhead > this.maxRollbackFrames) {
      // Rift stall: wait for remote input packet, but still broadcast our latest inputs so peer isn't deadlocked
      this.stallFrames++;
      this._verifyConfirmedHashes();
      const packetToSend = this._buildInputPacket(this.currentFrame + this.inputDelayFrames - 1);
      this.lastStepMs = performance.now() - t0;
      return {
        stepped: false,
        stalled: true,
        packetToSend,
        p1Mask: this.getPlayerInput(1, Math.max(0, this.currentFrame - 1)),
        p2Mask: this.getPlayerInput(2, Math.max(0, this.currentFrame - 1))
      };
    }

    // 3. Schedule local input at (currentFrame + inputDelayFrames)
    const targetInputFrame = this.currentFrame + this.inputDelayFrames;
    this._setPlayerInput(this.localPlayer, targetInputFrame, localButtonsMask, true);

    // 4. Save snapshot before stepping currentFrame
    const f = this.currentFrame;
    saveFastState(this.nes, this.saveRing[f % this.saveBufferSize], f);

    // 5. Step currentFrame with P1 and P2 inputs (confirmed or predicted)
    const p1Mask = this.getPlayerInput(1, f);
    const p2Mask = this.getPlayerInput(2, f);
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

    const packetToSend = this._buildInputPacket(targetInputFrame);
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
    const count = Math.min(16, latestScheduledFrame + 1);
    const inputs = new Array(count);
    for (let i = 0; i < count; i++) {
      inputs[i] = this.getLocalInputAt(latestScheduledFrame - i);
    }
    const pkt = {
      type: 'netplay_input',
      player: this.localPlayer,
      startFrame: latestScheduledFrame,
      inputs
    };
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
   * Exports a portable state object (for initial room handshake or manual resync).
   */
  exportSyncState() {
    patchJsnes8x16Sprites(this.nes);
    const nesState = this.nes.toJSON();
    let ptTileMap = null;
    if (this.nes.rom && this.nes.rom.vromCount > 0) {
      ptTileMap = new Array(512);
      for (let i = 0; i < 512; i++) {
        const t = this.nes.ppu.ptTile[i];
        ptTileMap[i] = t && typeof t._vromRef === 'number' ? t._vromRef : 0;
      }
      // Do not serialize 512 CHR-ROM tile pixel arrays when ptTileMap references are used
      nesState.ppu.ptTile = [];
    }
    return {
      frame: this.currentFrame,
      inputDelayFrames: this.inputDelayFrames,
      nesState,
      ptTileMap,
      hash: computeDeterministicHash(this.nes)
    };
  }

  /**
   * Imports a portable state object from Host and locks timeline to that exact frame.
   */
  importSyncState(syncObj) {
    if (!syncObj || !syncObj.nesState) return false;
    patchJsnes8x16Sprites(this.nes);
    const s = syncObj.nesState;
    this.nes.cpu.fromJSON(s.cpu);
    this.nes.mmap.fromJSON(s.mmap);

    const useRefMap =
      this.nes.rom && this.nes.rom.vromCount > 0 && Array.isArray(syncObj.ptTileMap);
    const origPtTile = this.nes.ppu.ptTile;
    if (useRefMap) {
      this.nes.ppu.ptTile = [];
    }
    this.nes.ppu.fromJSON(s.ppu);
    if (useRefMap) {
      this.nes.ppu.ptTile = origPtTile;
      for (let i = 0; i < 512; i++) {
        const ref = syncObj.ptTileMap[i] || 0;
        const b = (ref >> 8) & 0xff;
        const t = ref & 0xff;
        if (this.nes.rom.vromTile[b] && this.nes.rom.vromTile[b][t]) {
          this.nes.ppu.ptTile[i] = this.nes.rom.vromTile[b][t];
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
    this.resetTimeline(syncObj.frame || 0);
    return true;
  }

  getTelemetry() {
    return {
      currentFrame: this.currentFrame,
      lastConfirmedRemoteFrame: this.lastConfirmedRemoteFrame,
      frameAdvantage: this.currentFrame - Math.max(0, this.lastConfirmedRemoteFrame),
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
