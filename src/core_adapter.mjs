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
    systemId: 'sega_sms',
    name: 'Sega Master System / Game Gear',
    width: 256,
    height: 192,
    extensions: ['.sms', '.gg'],
    netplayMode: 'rollback',
    inputBits: 8
  },
  n3ds: {
    systemId: 'n3ds',
    name: 'Nintendo 3DS',
    width: 400,
    height: 480,
    extensions: ['.3ds', '.cci', '.cxi'],
    netplayMode: 'wireless_or_lockstep',
    inputBits: 32
  }
};

export const SUPPORTED_ROM_EXTENSIONS = Object.values(CONSOLE_PROFILES)
  .flatMap((p) => p.extensions);

export function detectSystemFromRomName(romName = '') {
  const lower = String(romName).trim().toLowerCase();
  for (const prof of Object.values(CONSOLE_PROFILES)) {
    if (prof.extensions.some((ext) => lower.endsWith(ext))) {
      return prof.systemId;
    }
  }
  return 'nes';
}

export function isSupportedRomFile(fileName = '') {
  const lower = String(fileName).trim().toLowerCase();
  return SUPPORTED_ROM_EXTENSIONS.some((ext) => lower.endsWith(ext));
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
    if (!slot || slot.frame < 0 || !slot.stateBytes) return false;
    if (typeof this.rawCore.loadStateBytes === 'function') {
      this.rawCore.loadStateBytes(slot.stateBytes);
      return true;
    }
    return false;
  }

  stepFrame(p1Mask, p2Mask, headless = false) {
    this.rawCore.stepFrame(p1Mask >>> 0, p2Mask >>> 0, Boolean(headless));
    if (!headless && this.opts.onFrame) {
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
      ? this.rawCore.saveStateBytes()
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
      this.rawCore.loadStateBytes(base64ToUint8(syncObj.rawStateB64));
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
