// Sega (Genesis Plus GX) & Super Nintendo (Snes9x) Libretro WASM Cores
import { INPUT_BITS, crc32Bytes } from './crc32.mjs';

const RGB565_TO_BGR24 = new Uint32Array(65536);
for (let p = 0; p < 65536; p++) {
  const r5 = (p >>> 11) & 0x1f;
  const g6 = (p >>> 5) & 0x3f;
  const b5 = p & 0x1f;
  const r = (r5 << 3) | (r5 >>> 2);
  const g = (g6 << 2) | (g6 >>> 4);
  const b = (b5 << 3) | (b5 >>> 2);
  RGB565_TO_BGR24[p] = (b << 16) | (g << 8) | r;
}

const RUNTIMES = {
  gpgx: {
    file: 'genesis_plus_gx_libretro',
    factory: null, wasmBinary: null, promise: null
  },
  snes9x: {
    file: 'snes9x_libretro',
    factory: null, wasmBinary: null, promise: null
  }
};

export async function ensureLibretroRuntime(coreKey = 'gpgx') {
  const rt = RUNTIMES[coreKey] || RUNTIMES.gpgx;
  if (rt.factory && rt.wasmBinary) {
    return { factory: rt.factory, wasmBinary: rt.wasmBinary };
  }
  if (rt.promise) return rt.promise;
  rt.promise = (async () => {
    if (typeof window !== 'undefined' && typeof fetch === 'function') {
      const [ns, res] = await Promise.all([
        import(`/vendor/${rt.file}.js?v=2`),
        fetch(`/vendor/${rt.file}.wasm?v=2`)
      ]);
      rt.factory = ns.default;
      rt.wasmBinary = new Uint8Array(await res.arrayBuffer());
    } else {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const url = await import('node:url');
      const dir = path.dirname(url.fileURLToPath(import.meta.url));
      const vDir = path.resolve(dir, '..', 'public', 'vendor');
      const jsUrl = url.pathToFileURL(path.join(vDir, `${rt.file}.js`)).href;
      const ns = await import(jsUrl);
      rt.factory = ns.default;
      rt.wasmBinary = new Uint8Array(
        fs.readFileSync(path.join(vDir, `${rt.file}.wasm`))
      );
    }
    return { factory: rt.factory, wasmBinary: rt.wasmBinary };
  })().catch((err) => {
    rt.promise = null;
    throw err;
  });
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
  if (systemId === 'snes') {
    if (mask & INPUT_BITS.Y) r |= 1 << 1;
    if (mask & INPUT_BITS.A) r |= 1 << 8;
    if (mask & INPUT_BITS.X) r |= 1 << 9;
    if (mask & INPUT_BITS.C) r |= 1 << 10;
    if (mask & INPUT_BITS.Z) r |= 1 << 11;
  } else {
    if (mask & INPUT_BITS.A) r |= 1 << 1;
    if (mask & INPUT_BITS.C) r |= 1 << 8;
    if (mask & INPUT_BITS.Y) r |= 1 << 9;
    if (mask & INPUT_BITS.X) r |= 1 << 10;
    if (mask & INPUT_BITS.Z) r |= 1 << 11;
  }
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
      mod.setValue(dataPtr, 0, 'i8');
      return 1;
    }
    if (cmd === 10) {
      const fmt = mod.getValue(dataPtr, 'i32');
      if (fmt === 0 || fmt === 1 || fmt === 2) {
        coreState.pixelFormat = fmt;
        return 1;
      }
      return 0;
    }
    if (cmd === 9 || cmd === 30 || cmd === 31 || cmd === 19) {
      const sysPtr = allocCString(mod, coreState.ptrs, '/system');
      mod.setValue(dataPtr, sysPtr, 'i32');
      return 1;
    }
    if (cmd === 27) {
      if (!coreState.logCbPtr) {
        coreState.logCbPtr = mod.addFunction(() => {}, 'viii');
      }
      mod.setValue(dataPtr, coreState.logCbPtr, 'i32');
      return 1;
    }
    if (cmd === 15) { mod.setValue(dataPtr + 4, 0, 'i32'); return 0; }
    if (cmd === 24) { mod.setValue(dataPtr, 2, 'i32'); return 1; }
    if (cmd === 51 || cmd === 16 || cmd === 53 || cmd === 54 ||
        cmd === 67 || cmd === 68 || cmd === 11 || cmd === 35 ||
        cmd === 36 || cmd === 37 || cmd === 8 || cmd === 6) {
      return 1;
    }
    return 0;
  }, 'iii');
  mod._retro_set_environment(envCb);
}

export async function createSegaGpgxCore({
  romBytes, romName = 'Game.md', systemId = 'sega_md',
  onFrame = null, onAudioSample = null
}) {
  const coreKey = systemId === 'snes' ? 'snes9x' : 'gpgx';
  const { factory, wasmBinary } = await ensureLibretroRuntime(coreKey);
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
        core.ppu._headlessFrame || !core.opts.onAudioSample) {
      return frames;
    }
    const cb = core.opts.onAudioSample;
    const s16 = mod.HEAP16;
    const base = dataPtr >>> 1;
    const outCount = Math.round((frames * 48000) / coreState.audioSampleRate);
    const scale = 1 / 32768;
    for (let i = 0; i < outCount; i++) {
      const srcIdx = Math.min(frames - 1, ((i * frames) / outCount) | 0) * 2;
      cb(s16[base + srcIdx] * scale, s16[base + srcIdx + 1] * scale);
    }
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
    const used = core._serializeTrimmedLen();
    slot.frame = frame;
    slot.usedLen = used;
    if (!slot.stateBytes || slot.stateBytes.length < used) {
      slot.stateBytes = new Uint8Array(Math.max(used, core._stateSize));
    }
    slot.stateBytes.set(
      mod.HEAPU8.subarray(core._statePtr, core._statePtr + used)
    );
  };

  core.loadStateFromSlot = function (slot) {
    if (!slot || slot.frame < 0 || !slot.stateBytes) return false;
    const used = slot.usedLen || slot.stateBytes.length;
    mod.HEAPU8.set(slot.stateBytes.subarray(0, used), core._statePtr);
    const clearEnd = Math.max(used, core._lastUsedLen);
    if (clearEnd > used) {
      mod.HEAPU8.fill(0, core._statePtr + used, core._statePtr + clearEnd);
    }
    core._lastUsedLen = used;
    return Boolean(mod._retro_unserialize(core._statePtr, core._stateSize));
  };

  core.saveStateBytes = function () {
    const used = core._serializeTrimmedLen();
    return mod.HEAPU8.slice(core._statePtr, core._statePtr + used);
  };

  core.loadStateBytes = function (bytes) {
    const used = Math.min(bytes.length, core._stateSize);
    const endPtr = core._statePtr + core._stateSize;
    mod.HEAPU8.set(bytes.subarray(0, used), core._statePtr);
    if (used < core._stateSize) {
      mod.HEAPU8.fill(0, core._statePtr + used, endPtr);
    }
    core._lastUsedLen = used;
    mod._retro_unserialize(core._statePtr, core._stateSize);
  };

  core.computeHash = function () {
    const ramPtr = mod._retro_get_memory_data(2);
    const ramLen = mod._retro_get_memory_size(2);
    const vramPtr = mod._retro_get_memory_data(3);
    const vramLen = mod._retro_get_memory_size(3);
    let h = 0;
    if (ramPtr && ramLen) h = crc32Bytes(mod.HEAPU8, ramPtr, ramLen, h);
    if (vramPtr && vramLen) h = crc32Bytes(mod.HEAPU8, vramPtr, vramLen, h);
    return h >>> 0;
  };

  core.stepFrame(0, 0, true);
  core._initialBootState = core.saveStateBytes();
  core.loadROM = function () {
    if (core._initialBootState) core.loadStateBytes(core._initialBootState);
  };

  return core;
}

export const createSnes9xCore = (opts) =>
  createSegaGpgxCore({ ...opts, systemId: 'snes' });
