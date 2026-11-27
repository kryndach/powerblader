// Shared DRY RGB565 LUT, ZIP Entry Manifest & Minimal Arcade Test ZIP Builder
import { crc32Bytes } from './crc32.mjs';

export const RGB565_TO_BGR24 = new Uint32Array(65536);
for (let p = 0; p < 65536; p++) {
  const r5 = (p >>> 11) & 0x1f;
  const g6 = (p >>> 5) & 0x3f;
  const b5 = p & 0x1f;
  RGB565_TO_BGR24[p] = (((b5 << 3) | (b5 >>> 2)) << 16) |
    (((g6 << 2) | (g6 >>> 4)) << 8) | ((r5 << 3) | (r5 >>> 2));
}

export function resampleStereoS16Linear(s16, base, frames, outCount, cb) {
  if (frames <= 0 || outCount <= 0) return;
  const scale = 1 / 32768;
  const maxIdx = Math.max(0, frames - 1);
  const step = frames / outCount;
  for (let i = 0; i < outCount; i++) {
    const pos = i * step;
    const i0 = Math.min(maxIdx, pos | 0);
    const i1 = Math.min(maxIdx, i0 + 1);
    const frac = pos - i0;
    const b0 = base + i0 * 2, b1 = base + i1 * 2;
    cb(
      (s16[b0] + (s16[b1] - s16[b0]) * frac) * scale,
      (s16[b0 + 1] + (s16[b1 + 1] - s16[b0 + 1]) * frac) * scale
    );
  }
}

export function listZipEntryNames(u8) {
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
  const dec = new TextDecoder('utf-8');
  for (
    let e = 0, cd = dv.getUint32(eocd + 16, true);
    e < total && cd + 46 <= u8.byteLength;
    e++
  ) {
    if (dv.getUint32(cd, true) !== 0x02014b50) break;
    const nLen = dv.getUint16(cd + 28, true);
    names.push(dec.decode(u8.subarray(cd + 46, cd + 46 + nLen)).toLowerCase());
    cd += 46 + nLen + dv.getUint16(cd + 30, true) +
      dv.getUint16(cd + 32, true);
  }
  return names;
}

function hasWasmMagic(u8) {
  return Boolean(
    u8 && u8.byteLength >= 8 &&
    u8[0] === 0x00 && u8[1] === 0x61 && u8[2] === 0x73 && u8[3] === 0x6d
  );
}

export async function fetchAndValidateBrowserWasm({
  wasmUrl, cacheKey, fileName, xfer = null, fetchImpl = null,
  minBytes = 200000
}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const hit = xfer
    ? await xfer.getCachedRomByCrc?.(cacheKey).catch(() => null) : null;
  if (hit?.u8) {
    const valid = hit.u8.byteLength > minBytes && hasWasmMagic(hit.u8) &&
      (typeof WebAssembly?.validate !== 'function' ||
        WebAssembly.validate(hit.u8));
    if (valid) return hit.u8;
    await xfer?.deleteCachedRomByCrc?.(cacheKey).catch(() => {});
  }
  const res = await doFetch(wasmUrl, hit ? { cache: 'reload' } : undefined);
  if (!res.ok) throw new Error(`${fileName} fetch HTTP ${res.status}`);
  const u8 = new Uint8Array(await res.arrayBuffer());
  const ok = hasWasmMagic(u8) &&
    (typeof WebAssembly?.validate !== 'function' || WebAssembly.validate(u8));
  if (!ok) throw new Error(`${fileName} invalid WASM binary`);
  xfer?.putCachedRomByCrc?.(cacheKey, fileName, u8);
  return u8;
}

export async function loadNodeVendorFactory(baseFile) {
  const [path, url] = await Promise.all([
    import('node:path'), import('node:url')
  ]);
  const vDir = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)), '..', 'public/vendor'
  );
  const ns = await import(
    url.pathToFileURL(path.join(vDir, `${baseFile}.js`)).href
  );
  return { factory: ns.default, vDir, path };
}

export async function loadNodeVendorWasm(baseFile) {
  const [fs, { factory, vDir, path }] = await Promise.all([
    import('node:fs'), loadNodeVendorFactory(baseFile)
  ]);
  const wasmBytes = new Uint8Array(
    fs.readFileSync(path.join(vDir, `${baseFile}.wasm`))
  );
  return { factory, wasmBytes };
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
  for (let i = 0; i < 32; i++) {
    t = (t & 0x80000000)
      ? (((t ^ 0xedb88320) << 1) | 1) >>> 0 : (t << 1) >>> 0;
  }
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
