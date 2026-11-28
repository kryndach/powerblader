// FinalBurn Neo (FBNeo) Deterministic Arcade WASM Core Adapter
import { INPUT_BITS, crc32Bytes } from './crc32.mjs';
import {
  RGB565_TO_BGR24, listZipEntryNames, loadNodeVendorFactory,
  loadNodeVendorWasm, createMinimalArcadeTestZip
} from './wasm_runtime_loader.mjs';

export { createMinimalArcadeTestZip };

let fbneoFactory = null, fbneoWasmModule = null, fbneoLoadPromise = null;
async function ensureFbneoFactoryOnly() {
  if (fbneoFactory) return fbneoFactory;
  if (!globalThis.process?.versions?.node) {
    const jsUrl = new URL('../vendor/fbneo_arcade.js?v=3', import.meta.url);
    const ns = await import(jsUrl.href);
    fbneoFactory = ns.default;
  } else {
    const { factory } = await loadNodeVendorFactory('fbneo_arcade');
    fbneoFactory = factory;
  }
  return fbneoFactory;
}
export async function ensureFbneoRuntime(
  onProgress = null, wasmModuleOverride = null
) {
  if (wasmModuleOverride) {
    const factory = await ensureFbneoFactoryOnly();
    fbneoWasmModule = wasmModuleOverride;
    return { factory, wasmModule: wasmModuleOverride };
  }
  if (fbneoFactory && fbneoWasmModule)
    return { factory: fbneoFactory, wasmModule: fbneoWasmModule };
  if (fbneoLoadPromise) return fbneoLoadPromise;
  fbneoLoadPromise = (async () => {
    onProgress?.(0, { pct: 0 });
    if (!globalThis.process?.versions?.node) {
      const jsUrl = new URL('../vendor/fbneo_arcade.js?v=3', import.meta.url);
      const xferUrl = new URL('../js/rom_fast_transfer.mjs', import.meta.url);
      const [ns, xfer] = await Promise.all([
        import(jsUrl.href),
        import(xferUrl.href)
      ]);
      fbneoFactory = ns.default;
      const wasmUrl = new URL(
        '../vendor/fbneo_arcade.wasm?v=3', import.meta.url
      ).href;
      const key = 'WASM_FBNEO_V3';
      const isLocal = xfer.isLocalHostRuntime();
      const hit = isLocal ? null : await xfer.getCachedRomByCrc(key);
      let u8 = hit?.u8?.byteLength > 1000000 ? hit.u8 : null;
      if (!u8) {
        if (isLocal) {
          const r = await fetch(wasmUrl);
          if (!r.ok) throw new Error(`FBNeo WASM HTTP ${r.status}`);
          u8 = new Uint8Array(await r.arrayBuffer());
        } else {
          const dl = await xfer.fetchStripedBinary(wasmUrl, { onProgress });
          if (!dl?.u8) throw new Error('Failed to load fbneo_arcade.wasm');
          u8 = dl.u8;
          xfer.putCachedRomByCrc(key, 'fbneo_arcade.wasm', u8);
        }
      }
      try { fbneoWasmModule = await WebAssembly.compile(u8); }
      catch {
        await xfer.deleteCachedRomByCrc(key);
        const fresh = await fetch(wasmUrl, { cache: 'reload' });
        if (!fresh.ok) throw new Error(`FBNeo reload HTTP ${fresh.status}`);
        u8 = new Uint8Array(await fresh.arrayBuffer());
        fbneoWasmModule = await WebAssembly.compile(u8);
        xfer.putCachedRomByCrc(key, 'fbneo_arcade.wasm', u8);
      }
    } else {
      const { factory, wasmBytes } = await loadNodeVendorWasm('fbneo_arcade');
      fbneoFactory = factory;
      fbneoWasmModule = await WebAssembly.compile(wasmBytes);
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
  onCoreProgress = null, wasmModuleOverride = null
}) {
  const { factory, wasmModule } = await ensureFbneoRuntime(
    onCoreProgress, wasmModuleOverride
  );
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
  core.getWasmModule = () => wasmModule;
  core.getRomBytes = () => u8;
  core.getRomName = () => romName;
  return core;
}
