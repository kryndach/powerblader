// FinalBurn Neo (FBNeo) Deterministic Arcade WASM Core Adapter
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

let fbneoFactory = null;
let fbneoWasmModule = null;
let fbneoLoadPromise = null;

export async function ensureFbneoRuntime() {
  if (fbneoFactory && fbneoWasmModule) {
    return { factory: fbneoFactory, wasmModule: fbneoWasmModule };
  }
  if (fbneoLoadPromise) return fbneoLoadPromise;
  fbneoLoadPromise = (async () => {
    let wasmBytes;
    if (typeof window !== 'undefined' && typeof fetch === 'function') {
      const [ns, res] = await Promise.all([
        import('/vendor/fbneo_arcade.js?v=2'),
        fetch('/vendor/fbneo_arcade.wasm?v=2')
      ]);
      fbneoFactory = ns.default;
      wasmBytes = new Uint8Array(await res.arrayBuffer());
    } else {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const url = await import('node:url');
      const dir = path.dirname(url.fileURLToPath(import.meta.url));
      const vDir = path.resolve(dir, '..', 'public', 'vendor');
      const jsUrl = url.pathToFileURL(path.join(vDir, 'fbneo_arcade.js')).href;
      const ns = await import(jsUrl);
      fbneoFactory = ns.default;
      wasmBytes = new Uint8Array(
        fs.readFileSync(path.join(vDir, 'fbneo_arcade.wasm'))
      );
    }
    fbneoWasmModule = await WebAssembly.compile(wasmBytes);
    return { factory: fbneoFactory, wasmModule: fbneoWasmModule };
  })().catch((err) => {
    fbneoLoadPromise = null;
    throw err;
  });
  return fbneoLoadPromise;
}

export function toFbneoInputMask(mask) {
  let b = 0;
  if (mask & INPUT_BITS.LEFT) b |= 0x001;
  if (mask & INPUT_BITS.RIGHT) b |= 0x002;
  if (mask & INPUT_BITS.UP) b |= 0x004;
  if (mask & INPUT_BITS.DOWN) b |= 0x008;
  if (mask & INPUT_BITS.START) b |= 0x010;
  if (mask & INPUT_BITS.SELECT) b |= 0x020;
  if (mask & INPUT_BITS.A) b |= 0x040;
  if (mask & INPUT_BITS.B) b |= 0x080;
  if (mask & INPUT_BITS.C) b |= 0x100;
  if (mask & INPUT_BITS.X) b |= 0x200;
  if (mask & INPUT_BITS.Y) b |= 0x400;
  if (mask & INPUT_BITS.Z) b |= 0x800;
  return b;
}
function listZipEntryNames(u8) {
  const names = [];
  if (!u8 || u8.byteLength < 30) return names;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) return names;
  let eocd = -1;
  const minPos = Math.max(0, u8.byteLength - 65557);
  for (let i = u8.byteLength - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return names;
  const total = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  for (let e = 0; e < total && cdOff + 46 <= u8.byteLength; e++) {
    if (dv.getUint32(cdOff, true) !== 0x02014b50) break;
    const nLen = dv.getUint16(cdOff + 28, true);
    const xLen = dv.getUint16(cdOff + 30, true);
    const cLen = dv.getUint16(cdOff + 32, true);
    names.push(
      dec.decode(u8.subarray(cdOff + 46, cdOff + 46 + nLen)).toLowerCase()
    );
    cdOff += 46 + nLen + xLen + cLen;
  }
  return names;
}
export function detectFbneoDriver(romBytes, romName = 'tgm2p.zip') {
  const entries = listZipEntryNames(romBytes);
  if (entries.some((n) => n.endsWith('1b.u22') || n.includes('tgm2p.'))) {
    return 'tgm2p';
  }
  if (entries.some((n) => n.includes('tgm2.default.nv'))) return 'tgm2';
  if (entries.some((n) => n.endsWith('d26-01.ic7'))) return 'minivadr';
  const base = String(romName)
    .replace(/^.*[\\/]/, '').replace(/\.(zip|7z|rar|fbneo)$/i, '');
  return base.split(/[\s([[]/)[0].trim().toLowerCase() || 'tgm2p';
}

export async function createFbneoArcadeCore({
  romBytes, romName = 'tgm2p.zip', onFrame = null, onAudioSample = null
}) {
  const { factory, wasmModule } = await ensureFbneoRuntime();
  const u8 = romBytes instanceof Uint8Array
    ? romBytes : new Uint8Array(romBytes);
  const driver = detectFbneoDriver(u8, romName);
  const missingFiles = [];

  const coreState = {
    rawW: 320, rawH: 240, rot: 0, depth: 32, fps: 60,
    headless: false, audioRate: 44100
  };
  let frameBuffer = new Uint32Array(320 * 240);

  const core = {
    systemId: 'arcade', width: 320, height: 240, frameBuffer, mod: null,
    ppu: { _headlessFrame: false, buffer: frameBuffer },
    rom: { mapperType: `FBNEO:${driver.toUpperCase()}`, vromCount: 1 },
    opts: { onFrame, onAudioSample }, _initialBootState: null
  };

  let romLoadedOk = false;
  let mod = null;
  mod = await factory({
    instantiateWasm(imports, successCallback) {
      WebAssembly.instantiate(wasmModule, imports).then((inst) => {
        successCallback(inst, wasmModule);
      });
      return {};
    },
    print: () => {},
    printErr: () => {},
    setRomProps: (w, h, rot, _flip, depth, fps) => {
      romLoadedOk = true;
      Object.assign(coreState, { rawW: w, rawH: h, rot, depth });
      if (fps >= 3000) coreState.fps = fps / 100;
      core.width = (rot & 1) ? h : w;
      core.height = (rot & 1) ? w : h;
      frameBuffer = new Uint32Array(core.width * core.height);
      core.frameBuffer = frameBuffer;
      core.ppu.buffer = frameBuffer;
    },
    setVisibleSize: () => {},
    setAspectRatio: () => {},
    addFile: (ptr, _type, ret) => {
      if (ret !== 0 && mod) missingFiles.push(mod.UTF8ToString(ptr));
    },
    addInput: () => {},
    addArchive: () => {},
    audioCallback: (soundPtr, length) => {
      if (!soundPtr || length <= 0 || coreState.headless ||
          core.ppu._headlessFrame || !core.opts.onAudioSample) {
        return;
      }
      const cb = core.opts.onAudioSample;
      const s16 = mod.HEAP16;
      const base = soundPtr >>> 1;
      const frames = length >>> 1;
      const outCount = Math.round((frames * 48000) / coreState.audioRate);
      const scale = 1 / 32768;
      const maxIdx = Math.max(0, frames - 1);
      const step = frames / outCount;
      for (let i = 0; i < outCount; i++) {
        const pos = i * step;
        const i0 = Math.min(maxIdx, pos | 0);
        const i1 = Math.min(maxIdx, i0 + 1);
        const frac = pos - i0;
        const b0 = base + i0 * 2;
        const b1 = base + i1 * 2;
        cb(
          (s16[b0] + (s16[b1] - s16[b0]) * frac) * scale,
          (s16[b0 + 1] + (s16[b1 + 1] - s16[b0 + 1]) * frac) * scale
        );
      }
    },
    drawScreen: (vidPtr) => {
      if (!vidPtr || coreState.headless || core.ppu._headlessFrame) return;
      const count = coreState.rawW * coreState.rawH;
      if (coreState.depth === 16) {
        const u16 = mod.HEAPU16;
        const base16 = vidPtr >>> 1;
        for (let i = 0; i < count; i++) {
          frameBuffer[i] = RGB565_TO_BGR24[u16[base16 + i]];
        }
      } else {
        const u32 = mod.HEAPU32;
        const base32 = vidPtr >>> 2;
        for (let i = 0; i < count; i++) {
          const px = u32[base32 + i];
          frameBuffer[i] =
            ((px & 0xff) << 16) | (px & 0x00ff00) | ((px >>> 16) & 0xff);
        }
      }
    }
  });
  core.mod = mod;
  try { mod.FS.mkdir('/roms'); } catch {}
  mod.FS.writeFile(`/roms/${driver}.zip`, u8);
  mod.cwrap('startMain', 'number', ['string'])(driver);
  if (!romLoadedOk) {
    const miss = missingFiles.length
      ? ` (missing: ${missingFiles.slice(0, 4).join(', ')})` : '';
    throw new Error(`FBNeo failed to boot arcade ROM "${driver}"${miss}`);
  }
  const statePath = `/libsdl/fbneo/states/${driver}.fs.all`;
  let stateNode = null;
  let stateDirty = true;

  function getMemfsStateView() {
    if (stateDirty) {
      mod._saveAllState(1);
      stateDirty = false;
      if (!stateNode) stateNode = mod.FS.lookupPath(statePath).node;
      const rawLen = stateNode.usedBytes;
      if (stateNode.contents.length < rawLen + 100) {
        const grown = new Uint8Array(rawLen + 1024);
        grown.set(stateNode.contents.subarray(0, rawLen));
        stateNode.contents = grown;
      }
      const h8 = mod.HEAPU8;
      const dst = stateNode.contents;
      dst.set(h8.subarray(0x1002544, 0x100254c), rawLen);
      dst.set(h8.subarray(0x10029a8, 0x10029ac), rawLen + 8);
      dst.set(h8.subarray(0x1023920, 0x1023960), rawLen + 12);
      dst.set(h8.subarray(0x102a790, 0x102a7a4), rawLen + 76);
      dst.set([0x46, 0x42, 0x58, 0x54], rawLen + 96);
      stateNode.usedBytes = rawLen + 100;
    }
    return stateNode.contents.subarray(0, stateNode.usedBytes);
  }
  core.stepFrame = function (p1Mask, p2Mask, headless = false) {
    coreState.headless = Boolean(headless);
    stateDirty = true;
    mod._setEmInput(0, toFbneoInputMask(p1Mask), 0, 0, 0, 0);
    mod._setEmInput(1, toFbneoInputMask(p2Mask), 0, 0, 0, 0);
    mod._collectGameInputs();
    mod._doLoop();
    coreState.headless = false;
  };
  core.getFrameBuffer = () => frameBuffer;
  core.saveStateBytes = () => new Uint8Array(getMemfsStateView());
  core.loadStateBytes = function (bytes) {
    if (!bytes || !bytes.length) return;
    if (stateNode && stateNode.contents.length >= bytes.length) {
      stateNode.contents.set(bytes);
      stateNode.usedBytes = bytes.length;
    } else {
      mod.FS.writeFile(statePath, bytes);
      stateNode = mod.FS.lookupPath(statePath).node;
    }
    stateDirty = false;
    mod._saveAllState(0);
    const n = bytes.length;
    if (n > 100 && bytes[n - 4] === 0x46 && bytes[n - 3] === 0x42 &&
        bytes[n - 2] === 0x58 && bytes[n - 1] === 0x54) {
      const b = n - 100;
      const h8 = mod.HEAPU8;
      h8.set(bytes.subarray(b, b + 8), 0x1002544);
      h8.set(bytes.subarray(b + 8, b + 12), 0x10029a8);
      h8.set(bytes.subarray(b + 12, b + 76), 0x1023920);
      h8.set(bytes.subarray(b + 76, b + 96), 0x102a790);
    }
  };
  core.saveStateInto = function (slot, frame) {
    const view = getMemfsStateView();
    slot.frame = frame;
    slot.usedLen = view.length;
    if (!slot.stateBytes || slot.stateBytes.length < view.length) {
      slot.stateBytes = new Uint8Array(view.length);
    }
    slot.stateBytes.set(view);
  };
  core.loadStateFromSlot = function (slot) {
    if (!slot || slot.frame < 0 || !slot.stateBytes) return false;
    core.loadStateBytes(
      slot.stateBytes.subarray(0, slot.usedLen || slot.stateBytes.length)
    );
    return true;
  };
  core.computeHash = () => crc32Bytes(getMemfsStateView()) >>> 0;
  core.stepFrame(0, 0, true);
  core._initialBootState = core.saveStateBytes();
  core.loadROM = () => {
    if (core._initialBootState) core.loadStateBytes(core._initialBootState);
  };
  return core;
}

export function createMinimalArcadeTestZip() {
  const rom = new Uint8Array(8192);
  rom.set([
    0xf3, 0xed, 0x56, 0x31, 0xff, 0xbf, 0x3a, 0x08, 0xe0, 0x21, 0xf0, 0xbf,
    0x34, 0x86, 0x01, 0x00, 0x02, 0x11, 0x00, 0xa2, 0x12, 0x13, 0x3c, 0x0b,
    0x67, 0x78, 0xb1, 0x7c, 0x20, 0xf6, 0xfb, 0x76, 0xc3, 0x06, 0x00
  ], 0);
  rom[0x38] = 0xfb;
  rom[0x39] = 0xc9;
  let target = ~2842460733 >>> 0;
  for (let i = 0; i < 32; i++) {
    target = (target & 0x80000000)
      ? (((target ^ 0xedb88320) << 1) | 1) >>> 0 : (target << 1) >>> 0;
  }
  const patch = (target ^ (~crc32Bytes(rom.subarray(0, 8188)) >>> 0)) >>> 0;
  rom.set(
    [patch & 255, (patch >>> 8) & 255, (patch >>> 16) & 255, patch >>> 24],
    8188
  );
  const name = new TextEncoder().encode('d26-01.ic7');
  const crc = crc32Bytes(rom) >>> 0;
  const out = new Uint8Array(30 + name.length + 8192 + 46 + name.length + 22);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint32(14, crc, true);
  dv.setUint32(18, 8192, true);
  dv.setUint32(22, 8192, true);
  dv.setUint16(26, name.length, true);
  out.set(name, 30);
  out.set(rom, 30 + name.length);
  const cd = 30 + name.length + 8192;
  dv.setUint32(cd, 0x02014b50, true);
  dv.setUint16(cd + 4, 20, true);
  dv.setUint16(cd + 6, 20, true);
  dv.setUint32(cd + 16, crc, true);
  dv.setUint32(cd + 20, 8192, true);
  dv.setUint32(cd + 24, 8192, true);
  dv.setUint16(cd + 28, name.length, true);
  out.set(name, cd + 46);
  const eocd = cd + 46 + name.length;
  dv.setUint32(eocd, 0x06054b50, true);
  dv.setUint16(eocd + 8, 1, true);
  dv.setUint16(eocd + 10, 1, true);
  dv.setUint32(eocd + 12, 46 + name.length, true);
  dv.setUint32(eocd + 16, cd, true);
  return out;
}
