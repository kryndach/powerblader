// Zero-GC Binary Ring-Buffer Savestates & Compact Network Sync Serialization
import { INPUT_BITS, computeDeterministicHash } from './crc32.mjs';
import { CPU_SCALAR_PROPS, PPU_SCALAR_PROPS } from './ppu_register_tables.mjs';
import { patchJsnes8x16Sprites } from './jsnes_ppu_patches.mjs';

export function createFastSnapshotSlot() {
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
    nes.mmap._vromAt0000 = -1;
    nes.mmap._vromAt1000 = -1;
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

export function serializeCompactNesState(
  nes,
  sessionId,
  frame,
  inputDelayFrames
) {
  patchJsnes8x16Sprites(nes);
  const nesState = nes.toJSON();
  let ptTileMap = null;
  let scantileMap = null;
  if (nes.rom && nes.rom.vromCount > 0) {
    ptTileMap = new Array(512);
    for (let i = 0; i < 512; i++) {
      const t = nes.ppu.ptTile[i];
      ptTileMap[i] = t && typeof t._vromRef === 'number' ? t._vromRef : 0;
    }
    nesState.ppu.ptTile = [];

    scantileMap = new Array(32);
    for (let i = 0; i < 32; i++) {
      const st = nes.ppu.scantile ? nes.ppu.scantile[i] : null;
      scantileMap[i] = st && typeof st._vromRef === 'number' ? st._vromRef : -1;
    }
  }
  delete nesState.ppu.buffer;
  delete nesState.ppu.bgbuffer;
  delete nesState.ppu.pixrendered;
  delete nesState.ppu.scantile;
  nesState.ppu._overclockEnabled = Boolean(nes.ppu._overclockEnabled);
  nesState.ppu._hasTightWaitLoop = Boolean(nes.ppu._hasTightWaitLoop);
  nesState.ppu._overclockCapped = Boolean(nes.ppu._overclockCapped);

  return {
    sessionId,
    frame,
    inputDelayFrames,
    nesState,
    ptTileMap,
    scantileMap,
    hash: computeDeterministicHash(nes)
  };
}

export function restoreCompactNesState(nes, syncObj) {
  if (!syncObj || !syncObj.nesState) return false;
  patchJsnes8x16Sprites(nes);
  const s = syncObj.nesState;
  if (nes.mmap) {
    nes.mmap._bankAt8000 = -1;
    nes.mmap._bankAtC000 = -1;
    nes.mmap._vromAt0000 = -1;
    nes.mmap._vromAt1000 = -1;
  }
  nes.mmap.fromJSON(s.mmap);
  nes.cpu.fromJSON(s.cpu);

  const ppu = nes.ppu;
  const useRefMap =
    nes.rom && nes.rom.vromCount > 0 && Array.isArray(syncObj.ptTileMap);
  const origPtTile = ppu.ptTile;
  const origScantile = ppu.scantile;
  const origBuffer = ppu.buffer;
  const origBgBuffer = ppu.bgbuffer;
  const origPixRendered = ppu.pixrendered;

  if (useRefMap) ppu.ptTile = [];
  ppu.fromJSON(s.ppu);
  ppu._overclockEnabled = Boolean(s.ppu._overclockEnabled);
  ppu._hasTightWaitLoop = Boolean(s.ppu._hasTightWaitLoop);
  ppu._overclockCapped = Boolean(s.ppu._overclockCapped);
  ppu._overclockScanlines = 0;
  ppu._inOverclock = false;

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
      if (nes.rom.vromTile[b] && nes.rom.vromTile[b][t]) {
        ppu.ptTile[i] = nes.rom.vromTile[b][t];
      }
    }
    if (Array.isArray(syncObj.scantileMap) && ppu.scantile) {
      for (let i = 0; i < 32; i++) {
        const ref = syncObj.scantileMap[i];
        if (typeof ref === 'number' && ref >= 0) {
          const b = (ref >> 8) & 0xff;
          const t = ref & 0xff;
          ppu.scantile[i] =
            nes.rom.vromTile[b] && nes.rom.vromTile[b][t]
              ? nes.rom.vromTile[b][t]
              : undefined;
        } else {
          ppu.scantile[i] = undefined;
        }
      }
    }
  }

  nes.papu.fromJSON(s.papu);
  if (s.controllers) {
    if (s.controllers[1]) nes.controllers[1].fromJSON(s.controllers[1]);
    if (s.controllers[2]) nes.controllers[2].fromJSON(s.controllers[2]);
  }
  return true;
}
