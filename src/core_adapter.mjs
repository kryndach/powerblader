// Multi-Console Emulator Core Adapter (NES, Sega Mega Drive/SMS, Nintendo 3DS)
import { crc32Bytes, computeDeterministicHash } from './crc32.mjs';
import { patchJsnes8x16Sprites } from './jsnes_ppu_patches.mjs';
import {
  createFastSnapshotSlot, saveFastState, loadFastState,
  applyControllerMask, serializeCompactNesState, restoreCompactNesState
} from './fast_savestate.mjs';
import { uint8ToBase64, base64ToUint8 } from './crc32.mjs';

export const SEGA_MD_INPUT_BITS = {
  UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8,
  A: 16, B: 32, C: 64, START: 128,
  X: 256, Y: 512, Z: 1024, MODE: 2048
};

export const N3DS_INPUT_BITS = {
  A: 1, B: 2, SELECT: 4, START: 8,
  RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128,
  R: 256, L: 512, X: 1024, Y: 2048,
  ZL: 4096, ZR: 8192
};

export const CONSOLE_PROFILES = {
  nes: {
    systemId: 'nes',
    name: 'Nintendo Entertainment System (NES)',
    width: 256,
    height: 240,
    extensions: ['.nes'],
    netplayMode: 'rollback',
    inputBits: 8
  },
  snes: {
    systemId: 'snes',
    name: 'Super Nintendo (SNES)',
    width: 256,
    height: 224,
    extensions: ['.sfc', '.smc', '.fig', '.swc'],
    netplayMode: 'rollback',
    inputBits: 12
  },
  sega_md: {
    systemId: 'sega_md',
    name: 'Sega Mega Drive / Genesis',
    width: 320,
    height: 224,
    extensions: ['.md', '.gen', '.smd', '.bin'],
    netplayMode: 'rollback',
    inputBits: 12
  },
  sega_sms: {
    systemId: 'sega_sms', name: 'Sega Master System / Game Gear',
    width: 256, height: 192, extensions: ['.sms', '.gg'],
    netplayMode: 'rollback', inputBits: 8
  },
  arcade: {
    systemId: 'arcade', name: 'Arcade (FinalBurn Neo)',
    width: 320, height: 240, extensions: ['.fbneo'],
    netplayMode: 'rollback', inputBits: 12
  },
  n3ds: {
    systemId: 'n3ds', name: 'Nintendo 3DS',
    width: 400, height: 480, extensions: ['.3ds', '.cci', '.cxi'],
    netplayMode: 'wireless_or_lockstep', inputBits: 32
  }
};

export const SUPPORTED_ROM_EXTENSIONS = Object.values(CONSOLE_PROFILES)
  .flatMap((p) => p.extensions);

export const ARCHIVE_EXTENSIONS = ['.zip', '.rar', '.7z'];

export function detectSystemFromRomName(romName = '') {
  const lower = String(romName).trim().toLowerCase();
  if (lower.startsWith('arcade/') || lower.startsWith('arcade\\') ||
      lower.endsWith('.zip')) {
    return 'arcade';
  }
  for (const prof of Object.values(CONSOLE_PROFILES)) {
    if (prof.extensions.some((ext) => lower.endsWith(ext))) {
      return prof.systemId;
    }
  }
  return 'nes';
}

export function detectSystemFromRomBytes(u8, romName = '') {
  if (u8 && u8.length >= 4) {
    if (u8[0] === 0x4e && u8[1] === 0x45 && u8[2] === 0x53 && u8[3] === 0x1a) {
      return 'nes';
    }
    if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) {
      return 'arcade';
    }
    if (u8.length > 0x110 &&
        u8[0x100] === 0x53 && u8[0x101] === 0x45 &&
        u8[0x102] === 0x47 && u8[0x103] === 0x41) {
      return 'sega_md';
    }
  }
  return detectSystemFromRomName(romName);
}

export function packSparseState(u8) {
  if (!u8 || u8.length < 64) return u8;
  const out = [
    0x5a, 0x52, 0x4c, 0x45,
    u8.length & 255, (u8.length >>> 8) & 255,
    (u8.length >>> 16) & 255, (u8.length >>> 24) & 255
  ];
  let i = 0;
  while (i < u8.length) {
    const b = u8[i++];
    if (b !== 0) {
      out.push(b);
      continue;
    }
    let run = 1;
    while (i < u8.length && u8[i] === 0 && run < 32767) {
      run++;
      i++;
    }
    out.push(0);
    if (run < 128) out.push(run);
    else out.push(0x80 | (run & 0x7f), (run >>> 7) & 0xff);
  }
  return new Uint8Array(out);
}

export function unpackSparseState(u8) {
  if (!u8 || u8.length < 8 || u8[0] !== 0x5a || u8[1] !== 0x52 ||
      u8[2] !== 0x4c || u8[3] !== 0x45) {
    return u8;
  }
  const len = (
    u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24)
  ) >>> 0;
  const out = new Uint8Array(len);
  let i = 8;
  let o = 0;
  while (i < u8.length && o < len) {
    const b = u8[i++];
    if (b !== 0) {
      out[o++] = b;
      continue;
    }
    let run = u8[i++];
    if (run & 0x80) run = (run & 0x7f) | (u8[i++] << 7);
    o += run;
  }
  return out;
}

export function isSupportedRomFile(fileName = '') {
  const lower = String(fileName).trim().toLowerCase();
  return SUPPORTED_ROM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isArchiveFile(fileName = '') {
  const lower = String(fileName).trim().toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isSupportedRomOrArchiveFile(fileName = '') {
  return isSupportedRomFile(fileName) || isArchiveFile(fileName);
}

export class NesCoreAdapter {
  constructor(nes) {
    this.isCoreAdapter = true;
    this.systemId = 'nes';
    this.width = 256;
    this.height = 240;
    this.pixelCount = 256 * 240;
    this.nes = nes;
    this.rawCore = nes;
    patchJsnes8x16Sprites(this.nes);
  }

  onTimelineReset(initSlot, startFrame) {
    patchJsnes8x16Sprites(this.nes);
    if (this.nes && this.nes.mmap) {
      this.nes.mmap._bankAt8000 = -1;
      this.nes.mmap._bankAtC000 = -1;
      this.nes.mmap._vromAt0000 = -1;
      this.nes.mmap._vromAt1000 = -1;
      saveFastState(this.nes, initSlot, startFrame);
    }
  }

  createSnapshotSlot() {
    return createFastSnapshotSlot();
  }

  resetSnapshotSlot(slot) {
    slot.frame = -1;
    if (slot.chrRamTileEpochs) slot.chrRamTileEpochs.fill(0);
  }

  saveState(slot, frame) {
    saveFastState(this.nes, slot, frame);
  }

  loadState(slot) {
    return loadFastState(this.nes, slot);
  }

  stepFrame(p1Mask, p2Mask, headless = false) {
    if (this.nes.ppu) this.nes.ppu._headlessFrame = Boolean(headless);
    applyControllerMask(this.nes, 1, p1Mask);
    applyControllerMask(this.nes, 2, p2Mask);
    this.nes.frame();
    if (this.nes.ppu && headless) this.nes.ppu._headlessFrame = false;
  }

  getFrameBuffer() {
    return this.nes.ppu ? this.nes.ppu.buffer : null;
  }

  computeHash() {
    return computeDeterministicHash(this.nes);
  }

  exportSyncState(sessionId, frame, inputDelayFrames) {
    return serializeCompactNesState(
      this.nes, sessionId, frame, inputDelayFrames
    );
  }

  importSyncState(syncObj) {
    return restoreCompactNesState(this.nes, syncObj);
  }
}

export class GenericCoreAdapter {
  constructor(spec) {
    this.isCoreAdapter = true;
    const prof = CONSOLE_PROFILES[spec.systemId] || CONSOLE_PROFILES.sega_md;
    this.systemId = spec.systemId || prof.systemId;
    this.width = spec.width || prof.width;
    this.height = spec.height || prof.height;
    this.pixelCount = this.width * this.height;
    this.rawCore = spec;
    this.opts = spec.opts || {};
  }

  onTimelineReset(initSlot, startFrame) {
    if (typeof this.rawCore.onTimelineReset === 'function') {
      this.rawCore.onTimelineReset(startFrame);
    }
    this.saveState(initSlot, startFrame);
  }

  createSnapshotSlot() {
    return { frame: -1, stateBytes: null };
  }

  resetSnapshotSlot(slot) {
    slot.frame = -1;
    slot.stateBytes = null;
  }

  saveState(slot, frame) {
    if (typeof this.rawCore.saveStateInto === 'function') {
      this.rawCore.saveStateInto(slot, frame);
      return;
    }
    slot.frame = frame;
    if (typeof this.rawCore.saveStateBytes === 'function') {
      const bytes = this.rawCore.saveStateBytes();
      if (!slot.stateBytes || slot.stateBytes.length !== bytes.length) {
        slot.stateBytes = new Uint8Array(bytes.length);
      }
      slot.stateBytes.set(bytes);
    }
  }

  loadState(slot) {
    if (typeof this.rawCore.loadStateFromSlot === 'function') {
      return this.rawCore.loadStateFromSlot(slot);
    }
    if (!slot || slot.frame < 0 || !slot.stateBytes) return false;
    if (typeof this.rawCore.loadStateBytes === 'function') {
      this.rawCore.loadStateBytes(slot.stateBytes);
      return true;
    }
    return false;
  }

  stepFrame(p1Mask, p2Mask, headless = false) {
    const isHeadless = Boolean(headless || this.rawCore.ppu?._headlessFrame);
    this.rawCore.stepFrame(p1Mask >>> 0, p2Mask >>> 0, isHeadless);
    if (!isHeadless && this.opts.onFrame) {
      const fb = this.getFrameBuffer();
      if (fb) this.opts.onFrame(fb);
    }
  }

  getFrameBuffer() {
    return typeof this.rawCore.getFrameBuffer === 'function'
      ? this.rawCore.getFrameBuffer()
      : null;
  }

  computeHash() {
    if (typeof this.rawCore.computeHash === 'function') {
      return this.rawCore.computeHash() >>> 0;
    }
    if (typeof this.rawCore.saveStateBytes === 'function') {
      return crc32Bytes(this.rawCore.saveStateBytes());
    }
    return 0;
  }

  exportSyncState(sessionId, frame, inputDelayFrames) {
    const bytes = typeof this.rawCore.saveStateBytes === 'function'
      ? packSparseState(this.rawCore.saveStateBytes())
      : new Uint8Array(0);
    return {
      v: 3,
      systemId: this.systemId,
      sessionId,
      frame,
      inputDelayFrames,
      rawStateB64: uint8ToBase64(bytes)
    };
  }

  importSyncState(syncObj) {
    if (!syncObj || typeof syncObj.rawStateB64 !== 'string') return false;
    if (typeof this.rawCore.loadStateBytes === 'function') {
      const raw = unpackSparseState(base64ToUint8(syncObj.rawStateB64));
      this.rawCore.loadStateBytes(raw);
      return true;
    }
    return false;
  }
}

export function ensureCoreAdapter(coreOrNes) {
  if (!coreOrNes) return null;
  if (coreOrNes.isCoreAdapter) return coreOrNes;
  if (coreOrNes.cpu && coreOrNes.ppu) return new NesCoreAdapter(coreOrNes);
  return new GenericCoreAdapter(coreOrNes);
}
