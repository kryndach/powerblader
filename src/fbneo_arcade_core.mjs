// FinalBurn Neo (FBNeo) Deterministic Arcade WASM Core Adapter
import { INPUT_BITS, crc32Bytes } from './crc32.mjs';

const RGB565_TO_BGR24 = new Uint32Array(65536);
for (let p = 0; p < 65536; p++) {
  const r5 = (p >>> 11) & 31, g6 = (p >>> 5) & 63, b5 = p & 31;
  RGB565_TO_BGR24[p] = (((b5 << 3) | (b5 >>> 2)) << 16) |
    (((g6 << 2) | (g6 >>> 4)) << 8) | ((r5 << 3) | (r5 >>> 2));
}
let fbneoFactory = null, fbneoWasmModule = null, fbneoLoadPromise = null;
export async function ensureFbneoRuntime(onProgress = null) {
  if (fbneoFactory && fbneoWasmModule)
    return { factory: fbneoFactory, wasmModule: fbneoWasmModule };
  if (fbneoLoadPromise) return fbneoLoadPromise;
  fbneoLoadPromise = (async () => {
    onProgress?.(0, { pct: 0 });
    if (typeof window !== 'undefined' && !globalThis.process?.versions?.node) {
      const [ns, xfer] = await Promise.all([
        import('/vendor/fbneo_arcade.js?v=3'),
        import('/js/rom_fast_transfer.mjs')
      ]);
      fbneoFactory = ns.default;
      const wasmUrl = '/vendor/fbneo_arcade.wasm?v=3', key = 'WASM_FBNEO_V3';
      const hit = await xfer.getCachedRomByCrc(key);
      let u8 = hit?.u8?.byteLength > 1000000 ? hit.u8 : null;
      if (!u8) {
        if (xfer.isLocalHostRuntime()) {
          const r = await fetch(wasmUrl);
          if (!r.ok) throw new Error(`FBNeo WASM HTTP ${r.status}`);
          u8 = new Uint8Array(await r.arrayBuffer());
        } else {
          const dl = await xfer.fetchStripedBinary(wasmUrl, { onProgress });
          if (!dl?.u8) throw new Error('Failed to load fbneo_arcade.wasm');
          u8 = dl.u8;
        }
        xfer.putCachedRomByCrc(key, 'fbneo_arcade.wasm', u8);
      }
      try { fbneoWasmModule = await WebAssembly.compile(u8); }
      catch {
        await xfer.deleteCachedRomByCrc(key);
        const fresh = await fetch(wasmUrl, { cache: 'reload' });
        u8 = new Uint8Array(await fresh.arrayBuffer());
        fbneoWasmModule = await WebAssembly.compile(u8);
        xfer.putCachedRomByCrc(key, 'fbneo_arcade.wasm', u8);
      }
    } else {
      const [fs, path, url] = await Promise.all([
        import('node:fs'), import('node:path'), import('node:url')
      ]);
      const vDir = path.resolve(
        path.dirname(url.fileURLToPath(import.meta.url)), '..', 'public/vendor'
      );
      fbneoFactory = (await import(
        url.pathToFileURL(path.join(vDir, 'fbneo_arcade.js')).href
      )).default;
      fbneoWasmModule = await WebAssembly.compile(
        new Uint8Array(fs.readFileSync(path.join(vDir, 'fbneo_arcade.wasm')))
      );
    }
    return { factory: fbneoFactory, wasmModule: fbneoWasmModule };
  })().catch((err) => { fbneoLoadPromise = null; throw err; });
  return fbneoLoadPromise;
}

const FBNEO_BIT_MAP = [
  [INPUT_BITS.LEFT, 1], [INPUT_BITS.RIGHT, 2], [INPUT_BITS.UP, 4],
  [INPUT_BITS.DOWN, 8], [INPUT_BITS.START, 16], [INPUT_BITS.SELECT, 32],
  [INPUT_BITS.A, 64], [INPUT_BITS.B, 128], [INPUT_BITS.C, 256],
  [INPUT_BITS.X, 512], [INPUT_BITS.Y, 1024], [INPUT_BITS.Z, 2048]
];
export function toFbneoInputMask(mask) {
  let b = 0;
  for (const [k, v] of FBNEO_BIT_MAP) if (mask & k) b |= v;
  return b;
}
function listZipEntryNames(u8) {
  const names = [];
  if (!u8 || u8.byteLength < 30) return names;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) return names;
  let eocd = -1;
  for (let i = u8.byteLength - 22; i >= Math.max(0, u8.byteLength - 65557); i--)
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return names;
  const total = dv.getUint16(eocd + 10, true), dec = new TextDecoder('utf-8');
  for (let e = 0, cd = dv.getUint32(eocd + 16, true);
       e < total && cd + 46 <= u8.byteLength; e++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) break;
    const nLen = dv.getUint16(cd + 28, true);
    names.push(dec.decode(u8.subarray(cd + 46, cd + 46 + nLen)).toLowerCase());
    cd += 46 + nLen + dv.getUint16(cd + 30, true) + dv.getUint16(cd + 32, true);
  }
  return names;
}
export function detectFbneoDriver(romBytes, romName = 'tgm2p.zip') {
  const entries = listZipEntryNames(romBytes);
  if (entries.some((n) => n.endsWith('1b.u22') || n.includes('tgm2p.')))
    return 'tgm2p';
  if (entries.some((n) => n.includes('tgm2.default.nv'))) return 'tgm2';
  if (entries.some((n) => n.endsWith('d26-01.ic7'))) return 'minivadr';
  const base = String(romName)
    .replace(/^.*[\\/]/, '').replace(/\.(zip|7z|rar|fbneo)$/i, '');
  return base.split(/[\s([[]/)[0].trim().toLowerCase() || 'tgm2p';
}
export async function createFbneoArcadeCore({
  romBytes, romName = 'tgm2p.zip', onFrame = null, onAudioSample = null,
  onCoreProgress = null
}) {
  const { factory, wasmModule } = await ensureFbneoRuntime(onCoreProgress);
  const u8 = romBytes instanceof Uint8Array
    ? romBytes : new Uint8Array(romBytes);
  const driver = detectFbneoDriver(u8, romName);
  const missingFiles = [], archOk = new Map();
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
  let romLoadedOk = false, mod = null;
  mod = await factory({
    instantiateWasm(imports, successCallback) {
      if (imports?.a) {
        if (imports.a.zd) imports.a.yd = imports.a.zd;
        imports.a.i = () => 1700000000000; imports.a.o = () => 0;
      }
      WebAssembly.instantiate(wasmModule, imports).then((inst) =>
        successCallback(inst, wasmModule)
      );
      return {};
    },
    print: () => {}, printErr: () => {},
    setRomProps: (w, h, rot, _flip, depth, fps) => {
      romLoadedOk = true;
      Object.assign(coreState, { rawW: w, rawH: h, rot, depth });
      if (fps >= 3000) coreState.fps = fps / 100;
      core.width = (rot & 1) ? h : w; core.height = (rot & 1) ? w : h;
      frameBuffer = new Uint32Array(core.width * core.height);
      core.frameBuffer = frameBuffer; core.ppu.buffer = frameBuffer;
    },
    setVisibleSize: () => {}, setAspectRatio: () => {},
    addFile: (ptr, _type, ret) => {
      if (ret !== 0 && mod) missingFiles.push(mod.UTF8ToString(ptr));
    },
    addInput: () => {},
    addArchive: (ptr, _p, ok) => {
      if (!mod) return;
      const a = mod.UTF8ToString(ptr);
      archOk.set(a, (archOk.get(a) || 0) | ok);
    },
    audioCallback: (soundPtr, length) => {
      if (!soundPtr || length <= 0 || coreState.headless ||
          core.ppu._headlessFrame || !core.opts.onAudioSample) return;
      const cb = core.opts.onAudioSample, s16 = mod.HEAP16;
      const base = soundPtr >>> 1, frames = length >>> 1;
      const outCount = Math.round((frames * 48000) / coreState.audioRate);
      const scale = 1 / 32768, maxIdx = Math.max(0, frames - 1);
      const step = frames / outCount;
      for (let i = 0; i < outCount; i++) {
        const pos = i * step, i0 = Math.min(maxIdx, pos | 0);
        const i1 = Math.min(maxIdx, i0 + 1), frac = pos - i0;
        const b0 = base + i0 * 2, b1 = base + i1 * 2;
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
        const u16 = mod.HEAPU16, base16 = vidPtr >>> 1;
        for (let i = 0; i < count; i++)
          frameBuffer[i] = RGB565_TO_BGR24[u16[base16 + i]];
      } else {
        const u32 = mod.HEAPU32, base32 = vidPtr >>> 2;
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
    const need = [...archOk.entries()]
      .filter(([, ok]) => !ok).map(([a]) => `${a}.zip`);
    const pMsg = need.length ? ` [needs parent/BIOS: ${need.join(', ')}]` : '';
    const miss = missingFiles.length
      ? ` (missing: ${missingFiles.slice(0, 4).join(', ')})` : '';
    throw new Error(`FBNeo failed to boot "${driver}"${pMsg}${miss}`);
  }
  const statePath = `/libsdl/fbneo/states/${driver}.fs.all`;
  let stateNode = null, stateDirty = true;
  function hookZeroGcStateNode(n) {
    if (!n || n._zeroGcHooked) return n;
    n._zeroGcHooked = true;
    const origSetattr = n.node_ops.setattr, origWrite = n.stream_ops.write;
    n.node_ops = {
      ...n.node_ops,
      setattr(node, attr) {
        if (attr.size === 0 && node.contents?.length > 0) {
          node.usedBytes = 0; return;
        }
        return origSetattr(node, attr);
      }
    };
    n.stream_ops = {
      ...n.stream_ops,
      write(stream, buf, off, len, pos, canOwn) {
        const node = stream.node;
        if (node.contents && pos + len <= node.contents.length) {
          node.contents.set(buf.subarray(off, off + len), pos);
          if (pos + len > node.usedBytes) node.usedBytes = pos + len;
          return len;
        }
        return origWrite(stream, buf, off, len, pos, canOwn);
      }
    };
    return n;
  }
  function getMemfsStateView() {
    if (stateDirty) {
      mod._saveAllState(1);
      stateDirty = false;
      if (!stateNode) {
        stateNode = hookZeroGcStateNode(mod.FS.lookupPath(statePath).node);
      }
      const rawLen = stateNode.usedBytes;
      if (stateNode.contents.length < rawLen + 100) {
        const grown = new Uint8Array(rawLen + 16384);
        grown.set(stateNode.contents.subarray(0, rawLen));
        stateNode.contents = grown;
      }
      const h8 = mod.HEAPU8, dst = stateNode.contents;
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
  core.getMemfsStateView = getMemfsStateView;
  core.saveStateBytes = () => new Uint8Array(getMemfsStateView());
  core.loadStateBytes = function (bytes) {
    if (!bytes?.length) return;
    if (stateNode && stateNode.contents.length >= bytes.length) {
      stateNode.contents.set(bytes);
      stateNode.usedBytes = bytes.length;
    } else {
      mod.FS.writeFile(statePath, bytes);
      stateNode = hookZeroGcStateNode(mod.FS.lookupPath(statePath).node);
    }
    stateDirty = false;
    mod._saveAllState(0);
    const n = bytes.length;
    if (n > 100 && bytes[n - 4] === 0x46 && bytes[n - 3] === 0x42 &&
        bytes[n - 2] === 0x58 && bytes[n - 1] === 0x54) {
      const b = n - 100, h8 = mod.HEAPU8;
      h8.set(bytes.subarray(b, b + 8), 0x1002544);
      h8.set(bytes.subarray(b + 8, b + 12), 0x10029a8);
      h8.set(bytes.subarray(b + 12, b + 76), 0x1023920);
      h8.set(bytes.subarray(b + 76, b + 96), 0x102a790);
    }
  };
  core.saveStateInto = function (slot, frame) {
    const view = getMemfsStateView();
    slot.frame = frame; slot.usedLen = view.length;
    if (!slot.stateBytes || slot.stateBytes.length < view.length)
      slot.stateBytes = new Uint8Array(view.length);
    slot.stateBytes.set(view);
  };
  core.loadStateFromSlot = function (slot) {
    if (!slot || slot.frame < 0 || !slot.stateBytes) return false;
    core.loadStateBytes(
      slot.stateBytes.subarray(0, slot.usedLen || slot.stateBytes.length)
    );
    return true;
  };
  core.computeHash = () => {
    const v = getMemfsStateView(), n = v.length;
    if (n <= 4096) return crc32Bytes(v) >>> 0;
    let h = crc32Bytes(v, 0, 2048, 0);
    h = crc32Bytes(v, (n >>> 1) - 1024, 2048, h);
    return crc32Bytes(v, n - 2048, 2048, h) >>> 0;
  };
  core.stepFrame(0, 0, true);
  core._initialBootState = core.saveStateBytes();
  core.loadROM = () =>
    core._initialBootState && core.loadStateBytes(core._initialBootState);
  return core;
}
export function createMinimalArcadeTestZip() {
  const rom = new Uint8Array(8192);
  rom.set([
    0xf3, 0xed, 0x56, 0x31, 0xff, 0xbf, 0x3a, 0x08, 0xe0, 0x21, 0xf0, 0xbf,
    0x34, 0x86, 0x01, 0x00, 0x02, 0x11, 0x00, 0xa2, 0x12, 0x13, 0x3c, 0x0b,
    0x67, 0x78, 0xb1, 0x7c, 0x20, 0xf6, 0xfb, 0x76, 0xc3, 0x06, 0x00
  ], 0);
  rom[0x38] = 0xfb; rom[0x39] = 0xc9;
  let t = ~2842460733 >>> 0;
  for (let i = 0; i < 32; i++)
    t = (t & 0x80000000) ? (((t ^ 0xedb88320) << 1) | 1) >>> 0 : (t << 1) >>> 0;
  const p = (t ^ (~crc32Bytes(rom.subarray(0, 8188)) >>> 0)) >>> 0;
  rom.set([p & 255, (p >>> 8) & 255, (p >>> 16) & 255, p >>> 24], 8188);
  const name = new TextEncoder().encode('d26-01.ic7');
  const crc = crc32Bytes(rom) >>> 0;
  const out = new Uint8Array(30 + name.length + 8192 + 46 + name.length + 22);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
  dv.setUint32(14, crc, true); dv.setUint32(18, 8192, true);
  dv.setUint32(22, 8192, true); dv.setUint16(26, name.length, true);
  out.set(name, 30); out.set(rom, 30 + name.length);
  const cd = 30 + name.length + 8192;
  dv.setUint32(cd, 0x02014b50, true); dv.setUint16(cd + 4, 20, true);
  dv.setUint16(cd + 6, 20, true); dv.setUint32(cd + 16, crc, true);
  dv.setUint32(cd + 20, 8192, true); dv.setUint32(cd + 24, 8192, true);
  dv.setUint16(cd + 28, name.length, true); out.set(name, cd + 46);
  const eocd = cd + 46 + name.length;
  dv.setUint32(eocd, 0x06054b50, true); dv.setUint16(eocd + 8, 1, true);
  dv.setUint16(eocd + 10, 1, true);
  dv.setUint32(eocd + 12, 46 + name.length, true);
  dv.setUint32(eocd + 16, cd, true);
  return out;
}
