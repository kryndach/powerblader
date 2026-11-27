// Universal Off-Thread Core Factory (FBNeo, Snes9x, Genesis Plus GX, NES)
import { createFbneoArcadeCore } from './fbneo_arcade_core.mjs';
import { createSegaGpgxCore } from './sega_gpgx_core.mjs';
import {
  patchJsnes8x16Sprites, setNesOverclockEnabled
} from './jsnes_ppu_patches.mjs';
import {
  applyControllerMask, serializeCompactNesState, restoreCompactNesState
} from './fast_savestate.mjs';
import { computeDeterministicHash } from './crc32.mjs';

let cachedJsnes = null;
const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();

function rebuildChrRamTilesFromVram(nes) {
  if (!nes?.ppu || (nes.rom && nes.rom.vromCount > 0)) return;
  const vram = nes.ppu.vramMem;
  const tiles = nes.ppu.ptTile;
  for (let t = 0; t < 512; t++) {
    const base = t << 4;
    const tile = tiles[t];
    if (!tile) continue;
    for (let row = 0; row < 8; row++) {
      tile.setScanline(row, vram[base + row], vram[base + row + 8]);
    }
  }
}

export function encodeNesStateBytes(nes) {
  const compact = serializeCompactNesState(nes, 'sw', 0, 0);
  if (compact.nesState?.ppu && (!nes.rom || nes.rom.vromCount === 0)) {
    compact.nesState.ppu.ptTile = [];
    compact.rebuildChrRam = true;
  }
  return TEXT_ENC.encode(JSON.stringify(compact));
}

export function decodeNesStateBytes(nes, bytes) {
  const obj = JSON.parse(TEXT_DEC.decode(bytes));
  const origPtTile = obj.rebuildChrRam ? nes.ppu?.ptTile : null;
  if (origPtTile) nes.ppu.ptTile = [];
  const ok = restoreCompactNesState(nes, obj);
  if (origPtTile) {
    nes.ppu.ptTile = origPtTile;
    rebuildChrRamTilesFromVram(nes);
  }
  return ok;
}

async function loadJsnesModule() {
  if (cachedJsnes) return cachedJsnes;
  if (globalThis.process?.versions?.node) {
    const mod = await import('jsnes');
    cachedJsnes = mod.NES ? mod : mod.default;
    return cachedJsnes;
  }
  if (globalThis.jsnes?.NES) {
    cachedJsnes = globalThis.jsnes;
    return cachedJsnes;
  }
  const url = new URL('../vendor/jsnes.js', import.meta.url);
  const res = await fetch(url.href);
  if (!res.ok) throw new Error(`jsnes worker fetch HTTP ${res.status}`);
  const src = await res.text();
  const modObj = { exports: {} };
  const fn = new Function('module', 'exports', src);
  fn(modObj, modObj.exports);
  cachedJsnes = modObj.exports?.NES ? modObj.exports : globalThis.jsnes;
  if (!cachedJsnes?.NES) throw new Error('Failed to load jsnes in Worker');
  return cachedJsnes;
}

function toBinaryString(romBytes) {
  if (typeof romBytes === 'string') return romBytes;
  const u8 = romBytes instanceof Uint8Array
    ? romBytes : new Uint8Array(romBytes);
  let out = '';
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + step));
  }
  return out;
}

async function createNesWorkerCore({ romBytes, overclockMode = 0 }) {
  const jsnes = await loadJsnesModule();
  const nes = new jsnes.NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(toBinaryString(romBytes));
  patchJsnes8x16Sprites(nes);
  setNesOverclockEnabled(nes, overclockMode);
  return {
    systemId: 'nes',
    stepFrame(p1Mask, p2Mask, headless = true) {
      if (nes.ppu) nes.ppu._headlessFrame = Boolean(headless);
      applyControllerMask(nes, 1, p1Mask);
      applyControllerMask(nes, 2, p2Mask);
      nes.frame();
      if (nes.ppu && headless) nes.ppu._headlessFrame = false;
    },
    saveStateBytes: () => encodeNesStateBytes(nes),
    loadStateBytes: (bytes) => decodeNesStateBytes(nes, bytes),
    computeHash: () => computeDeterministicHash(nes),
    setOverclockMode: (m) => setNesOverclockEnabled(nes, m),
    destroy() {}
  };
}

export async function createUniversalWorkerCore(spec) {
  const sys = spec?.systemId || 'arcade';
  if (sys === 'nes') return createNesWorkerCore(spec);
  if (sys === 'snes' || sys === 'sega_md' || sys === 'sega_sms') {
    return createSegaGpgxCore({
      romBytes: spec.romBytes,
      romName: spec.romName,
      systemId: sys,
      wasmBinaryOverride: spec.wasmBinaryOverride || null
    });
  }
  return createFbneoArcadeCore({
    romBytes: spec.romBytes,
    romName: spec.romName,
    wasmModuleOverride: spec.wasmModuleOverride || null
  });
}
