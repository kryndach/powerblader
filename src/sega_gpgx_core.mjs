// Sega (Genesis Plus GX) & Super Nintendo (Snes9x) Libretro WASM Cores
import { INPUT_BITS, crc32Bytes } from './crc32.mjs';
import {
  RGB565_TO_BGR24, loadNodeVendorWasm, resampleStereoS16Linear,
  fetchAndValidateBrowserWasm
} from './wasm_runtime_loader.mjs';

export { resampleStereoS16Linear };

const RUNTIMES = {
  gpgx: { file: 'genesis_plus_gx_libretro', factory: null, wasmBinary: null },
  snes9x: { file: 'snes9x_libretro', factory: null, wasmBinary: null }
};
const GPGX_EXT = [
  [0xfe530, 0xfe538], [0x2f75a4, 0x2f75a8],
  [0x328608, 0x328610], [0x524c60, 0x524d40]
];
const GPGX_EXT_LEN = 248;

export async function ensureLibretroRuntime(
  coreKey = 'gpgx', wasmBinaryOverride = null
) {
  const rt = RUNTIMES[coreKey] || RUNTIMES.gpgx;
  if (wasmBinaryOverride && rt.factory) {
    return { factory: rt.factory, wasmBinary: wasmBinaryOverride };
  }
  if (rt.factory && rt.wasmBinary) {
    return { factory: rt.factory, wasmBinary: rt.wasmBinary };
  }
  if (rt.promise) return rt.promise;
  rt.promise = (async () => {
    if (!globalThis.process?.versions?.node && typeof fetch === 'function') {
      const jsUrl = new URL(`../vendor/${rt.file}.js?v=2`, import.meta.url);
      const wasmUrl = new URL(`../vendor/${rt.file}.wasm?v=2`, import.meta.url);
      const xferUrl = new URL('../js/rom_fast_transfer.mjs', import.meta.url);
      const [ns, xfer] = await Promise.all([
        import(jsUrl.href), import(xferUrl.href).catch(() => null)
      ]);
      rt.factory = ns.default;
      if (wasmBinaryOverride) rt.wasmBinary = wasmBinaryOverride;
      else {
        rt.wasmBinary = await fetchAndValidateBrowserWasm({
          wasmUrl: wasmUrl.href,
          cacheKey: `WASM_${coreKey.toUpperCase()}_V2`,
          fileName: `${rt.file}.wasm`,
          xfer
        });
      }
    } else {
      const { factory, wasmBytes } = await loadNodeVendorWasm(rt.file);
      rt.factory = factory;
      rt.wasmBinary = wasmBinaryOverride || wasmBytes;
    }
    return { factory: rt.factory, wasmBinary: rt.wasmBinary };
  })().catch((err) => { rt.promise = null; throw err; });
  return rt.promise;
}

export const ensureGpgxRuntime = () => ensureLibretroRuntime('gpgx');
export const ensureSnes9xRuntime = () => ensureLibretroRuntime('snes9x');

export function toRetroPadMask(mask, systemId = 'sega_md') {
  let r = 0;
  if (mask & INPUT_BITS.B) r |= 1 << 0;
  if (mask & INPUT_BITS.SELECT) r |= 1 << 2;
  if (mask & INPUT_BITS.START) r |= 1 << 3;
  if (mask & INPUT_BITS.UP) r |= 1 << 4;
  if (mask & INPUT_BITS.DOWN) r |= 1 << 5;
  if (mask & INPUT_BITS.LEFT) r |= 1 << 6;
  if (mask & INPUT_BITS.RIGHT) r |= 1 << 7;
  if (mask & INPUT_BITS.X) r |= 1 << (systemId === 'snes' ? 9 : 10);
  if (mask & INPUT_BITS.Y) r |= 1 << (systemId === 'snes' ? 1 : 9);
  if (mask & INPUT_BITS.A) r |= 1 << (systemId === 'snes' ? 8 : 1);
  if (mask & INPUT_BITS.C) r |= 1 << (systemId === 'snes' ? 10 : 8);
  if (mask & INPUT_BITS.Z) r |= 1 << 11;
  return r;
}

function allocCString(mod, ptrs, str) {
  const bytes = new TextEncoder().encode(str + '\0');
  const ptr = mod._malloc(bytes.length);
  mod.HEAPU8.set(bytes, ptr);
  ptrs.push(ptr);
  return ptr;
}

function wireLibretroEnv(mod, coreState) {
  const envCb = mod.addFunction((rawCmd, dataPtr) => {
    const cmd = rawCmd & ~0x10000;
    if (cmd === 3) { mod.setValue(dataPtr, 1, 'i8'); return 1; }
    if (cmd === 2 || cmd === 17 || cmd === 49) {
      mod.setValue(dataPtr, 0, 'i8'); return 1;
    }
    if (cmd === 10) {
      const fmt = mod.getValue(dataPtr, 'i32');
      if (fmt >= 0 && fmt <= 2) { coreState.pixelFormat = fmt; return 1; }
      return 0;
    }
    if (cmd === 9 || cmd === 30 || cmd === 31 || cmd === 19) {
      const p = allocCString(mod, coreState.ptrs, '/system');
      mod.setValue(dataPtr, p, 'i32');
      return 1;
    }
    if (cmd === 27) {
      coreState.logCbPtr ||= mod.addFunction(() => {}, 'viii');
      mod.setValue(dataPtr, coreState.logCbPtr, 'i32');
      return 1;
    }
    if (cmd === 15) { mod.setValue(dataPtr + 4, 0, 'i32'); return 0; }
    if (cmd === 24) { mod.setValue(dataPtr, 2, 'i32'); return 1; }
    return [6, 8, 11, 16, 35, 36, 37, 51, 53, 54, 67, 68].includes(cmd) ? 1 : 0;
  }, 'iii');
  mod._retro_set_environment(envCb);
}

export async function createSegaGpgxCore({
  romBytes, romName = 'Game.md', systemId = 'sega_md',
  onFrame = null, onAudioSample = null, wasmBinaryOverride = null
}) {
  const coreKey = systemId === 'snes' ? 'snes9x' : 'gpgx';
  const { factory, wasmBinary } = await ensureLibretroRuntime(
    coreKey, wasmBinaryOverride
  );
  const mod = await factory({
    wasmBinary, noInitialRun: true, print: () => {}, printErr: () => {}
  });

  const width = systemId === 'sega_md' ? 320 : 256;
  const height = systemId === 'sega_sms' ? 192 : 224;
  const frameBuffer = new Uint32Array(width * height);
  const coreState = {
    pixelFormat: 2, ports: [0, 0], headless: false,
    audioSampleRate: 44100, ptrs: [], logCbPtr: 0
  };
  const mType = systemId === 'snes'
    ? 'SNES' : systemId === 'sega_sms' ? 'SEGA-SMS' : 'SEGA-MD';

  const core = {
    systemId, width, height, frameBuffer, mod,
    ppu: { _headlessFrame: false, buffer: frameBuffer },
    rom: { mapperType: mType, vromCount: 1 },
    opts: { onFrame, onAudioSample },
    _statePtr: 0, _stateSize: 0, _lastUsedLen: 0, _initialBootState: null
  };

  wireLibretroEnv(mod, coreState);

  const videoCb = mod.addFunction((dataPtr, w, h, pitch) => {
    if (!dataPtr || coreState.headless || core.ppu._headlessFrame) return;
    if (w <= 0 || h <= 0) return;
    const u16 = mod.HEAPU16;
    const pitch16 = pitch >>> 1;
    const base16 = dataPtr >>> 1;
    if (w === width && h === height) {
      let dst = 0;
      for (let y = 0; y < height; y++) {
        let src = base16 + y * pitch16;
        for (let x = 0; x < width; x++) {
          frameBuffer[dst++] = RGB565_TO_BGR24[u16[src++]];
        }
      }
      return;
    }
    let dst = 0;
    for (let y = 0; y < height; y++) {
      const sy = ((y * h) / height) | 0;
      const rowBase = base16 + sy * pitch16;
      for (let x = 0; x < width; x++) {
        const sx = ((x * w) / width) | 0;
        frameBuffer[dst++] = RGB565_TO_BGR24[u16[rowBase + sx]];
      }
    }
  }, 'viiii');
  mod._retro_set_video_refresh(videoCb);

  const audioBatchCb = mod.addFunction((dataPtr, frames) => {
    if (!dataPtr || frames <= 0 || coreState.headless ||
        core.ppu._headlessFrame || !core.opts.onAudioSample) return frames;
    const outCount = Math.round((frames * 48000) / coreState.audioSampleRate);
    resampleStereoS16Linear(
      mod.HEAP16, dataPtr >>> 1, frames, outCount, core.opts.onAudioSample
    );
    return frames;
  }, 'iii');
  mod._retro_set_audio_sample_batch(audioBatchCb);
  mod._retro_set_audio_sample(mod.addFunction(() => {}, 'vii'));
  mod._retro_set_input_poll(mod.addFunction(() => {}, 'v'));

  const inputStateCb = mod.addFunction((port, _device, _idx, id) => {
    if (port !== 0 && port !== 1) return 0;
    const bits = coreState.ports[port];
    return id === 256 ? bits : (bits & (1 << id) ? 1 : 0);
  }, 'iiiii');
  mod._retro_set_input_state(inputStateCb);
  mod._retro_init();

  const lower = String(romName).toLowerCase();
  const ext = systemId === 'snes'
    ? '.sfc'
    : lower.endsWith('.gg') ? '.gg' : lower.endsWith('.sms') ? '.sms' : '.md';
  const vfsPath = `/rom${ext}`;
  const u8 = romBytes instanceof Uint8Array
    ? romBytes : new Uint8Array(romBytes);
  try {
    if (mod.FS) mod.FS.writeFile(vfsPath, u8);
  } catch {}

  const dataPtr = mod._malloc(u8.length);
  mod.HEAPU8.set(u8, dataPtr);
  const pathPtr = allocCString(mod, coreState.ptrs, vfsPath);
  const infoPtr = mod._malloc(16);
  mod.setValue(infoPtr + 0, pathPtr, 'i32');
  mod.setValue(infoPtr + 4, dataPtr, 'i32');
  mod.setValue(infoPtr + 8, u8.length, 'i32');
  mod.setValue(infoPtr + 12, 0, 'i32');
  const ok = mod._retro_load_game(infoPtr);
  mod._free(infoPtr);
  if (!ok) throw new Error(`Libretro core refused ROM "${romName}"`);

  const avPtr = mod._malloc(64);
  mod._retro_get_system_av_info(avPtr);
  const sr = mod.getValue(avPtr + 32, 'double');
  if (sr >= 8000 && sr <= 96000) coreState.audioSampleRate = sr;
  mod._free(avPtr);

  mod._retro_set_controller_port_device(0, 1);
  mod._retro_set_controller_port_device(1, 1);

  core._stateSize = mod._retro_serialize_size();
  const alignedSz = (core._stateSize + 7) & ~3;
  core._statePtr = mod._malloc(alignedSz);
  mod.HEAPU8.fill(0, core._statePtr, core._statePtr + alignedSz);

  core.stepFrame = function (p1Mask, p2Mask, headless = false) {
    if (core._destroyed) return;
    coreState.ports[0] = toRetroPadMask(p1Mask, systemId);
    coreState.ports[1] = toRetroPadMask(p2Mask, systemId);
    coreState.headless = Boolean(headless);
    mod._retro_run();
    coreState.headless = false;
  };

  core.getFrameBuffer = () => frameBuffer;

  core._serializeTrimmedLen = function () {
    mod._retro_serialize(core._statePtr, core._stateSize);
    const u32 = mod.HEAPU32;
    const baseWord = core._statePtr >>> 2;
    let wIdx = ((core._stateSize + 3) >>> 2) - 1;
    while (wIdx > 0 && u32[baseWord + wIdx] === 0) wIdx--;
    const used = Math.min(core._stateSize, (wIdx + 2) << 2);
    if (used > core._lastUsedLen) core._lastUsedLen = used;
    return used;
  };

  core.saveStateInto = function (slot, frame) {
    const rawUsed = core._serializeTrimmedLen();
    const ext = coreKey === 'gpgx' ? GPGX_EXT_LEN : 0;
    const total = rawUsed + ext;
    slot.frame = frame;
    slot.usedLen = total;
    if (!slot.stateBytes || slot.stateBytes.length < total) {
      slot.stateBytes = new Uint8Array(Math.max(total, core._stateSize + ext));
    }
    slot.stateBytes.set(
      mod.HEAPU8.subarray(core._statePtr, core._statePtr + rawUsed)
    );
    if (ext) {
      let p = rawUsed;
      slot.stateBytes.set([0x47, 0x50, 0x58, 0x54], p);
      p += 4;
      for (const [s, e] of GPGX_EXT) {
        slot.stateBytes.set(mod.HEAPU8.subarray(s, e), p);
        p += e - s;
      }
    }
  };

  core.loadStateFromSlot = function (slot) {
    if (!slot || slot.frame < 0 || !slot.stateBytes) return false;
    const total = slot.usedLen || slot.stateBytes.length;
    const b = slot.stateBytes;
    const tOff = total - GPGX_EXT_LEN;
    const hasExt = coreKey === 'gpgx' && tOff > 0 && b[tOff] === 0x47 &&
      b[tOff + 1] === 0x50 && b[tOff + 2] === 0x58 && b[tOff + 3] === 0x54;
    const rawUsed = Math.min(hasExt ? tOff : total, core._stateSize);
    mod.HEAPU8.set(b.subarray(0, rawUsed), core._statePtr);
    const clearEnd = Math.max(rawUsed, core._lastUsedLen);
    if (clearEnd > rawUsed) {
      mod.HEAPU8.fill(0, core._statePtr + rawUsed, core._statePtr + clearEnd);
    }
    core._lastUsedLen = rawUsed;
    const ok = Boolean(mod._retro_unserialize(core._statePtr, core._stateSize));
    if (hasExt) {
      let p = tOff + 4;
      for (const [s, e] of GPGX_EXT) {
        mod.HEAPU8.set(b.subarray(p, p + (e - s)), s);
        p += e - s;
      }
    }
    return ok;
  };

  const tmpSlot = { frame: 0, usedLen: 0, stateBytes: null };
  core.saveStateBytes = () => {
    core.saveStateInto(tmpSlot, 0);
    return tmpSlot.stateBytes.slice(0, tmpSlot.usedLen);
  };
  core.loadStateBytes = (bytes) => core.loadStateFromSlot({
    frame: 0, usedLen: bytes.length, stateBytes: bytes
  });
  core.computeHash = () => {
    const rP = mod._retro_get_memory_data(2);
    const rL = mod._retro_get_memory_size(2);
    const vP = mod._retro_get_memory_data(3);
    const vL = mod._retro_get_memory_size(3);
    let h = rP && rL ? crc32Bytes(mod.HEAPU8, rP, rL, 0) : 0;
    if (vP && vL) h = crc32Bytes(mod.HEAPU8, vP, vL, h);
    return h >>> 0;
  };
  core.stepFrame(0, 0, true);
  core._initialBootState = core.saveStateBytes();
  core.loadROM = () =>
    core._initialBootState && core.loadStateBytes(core._initialBootState);
  core.getWasmBinary = () => wasmBinary;
  core.getRomBytes = () => u8;
  core.getRomName = () => romName;
  core.destroy = function () {
    if (core._destroyed) return;
    core._destroyed = true;
    try { mod._retro_unload_game?.(); mod._retro_deinit?.(); } catch {}
    try {
      if (core._statePtr) mod._free?.(core._statePtr);
      if (dataPtr) mod._free?.(dataPtr);
      for (const p of coreState.ptrs) mod._free?.(p);
    } catch {}
    coreState.ptrs.length = 0;
  };
  return core;
}

export const createSnes9xCore = (opts) =>
  createSegaGpgxCore({ ...opts, systemId: 'snes' });
