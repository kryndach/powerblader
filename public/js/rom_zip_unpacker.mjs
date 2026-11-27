// Client-Side Browser ZIP Extractor & Server Archive Unpacker
import { isLocalHostRuntime } from './rom_fast_transfer.mjs';
import { buildApiUrl } from './server_endpoint.mjs';

const ROM_EXTS = [
  '.nes', '.sfc', '.smc', '.fig', '.swc', '.md', '.gen', '.smd',
  '.bin', '.sms', '.gg', '.3ds'
];
const ARCHIVE_EXTS = ['.zip', '.rar', '.7z'];
const isRomEntryName = (name = '') =>
  ROM_EXTS.some((ext) => String(name).trim().toLowerCase().endsWith(ext));

function isArchiveNameOrMagic(name = '', u8 = null) {
  const lower = String(name).trim().toLowerCase();
  if (ARCHIVE_EXTS.some((ext) => lower.endsWith(ext))) return true;
  if (!u8 || u8.length < 6) return false;
  return (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03) ||
    (u8[0] === 0x52 && u8[1] === 0x61 && u8[2] === 0x72) ||
    (u8[0] === 0x37 && u8[1] === 0x7a && u8[2] === 0xbc);
}

const baseName = (p) => String(p).replace(/\\/g, '/').split('/').pop() || 'ROM';

export async function extractRomFromZipBrowser(u8) {
  if (!u8 || u8.byteLength < 30) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) return null;
  let eocd = -1;
  const minEocd = Math.max(0, u8.byteLength - 65557);
  for (let i = u8.byteLength - 22; i >= minEocd; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const totalEntries = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  for (let e = 0; e < totalEntries && cdOff + 46 <= u8.byteLength; e++) {
    if (dv.getUint32(cdOff, true) !== 0x02014b50) break;
    const method = dv.getUint16(cdOff + 10, true);
    const compSize = dv.getUint32(cdOff + 20, true);
    const nLen = dv.getUint16(cdOff + 28, true);
    const lOff = dv.getUint32(cdOff + 42, true);
    const rawName = decoder.decode(u8.subarray(cdOff + 46, cdOff + 46 + nLen));
    cdOff += 46 + nLen + dv.getUint16(cdOff + 30, true) +
      dv.getUint16(cdOff + 32, true);
    const cleanName = baseName(rawName);
    if (!isRomEntryName(cleanName) ||
        (cleanName.toLowerCase().endsWith('.bin') && totalEntries > 1) ||
        lOff + 30 > u8.byteLength ||
        dv.getUint32(lOff, true) !== 0x04034b50) continue;
    const start = lOff + 30 + dv.getUint16(lOff + 26, true) +
      dv.getUint16(lOff + 28, true);
    const compSlice = u8.subarray(start, start + compSize);
    if (method === 0) {
      return { romName: cleanName, romUint8: new Uint8Array(compSlice) };
    }
    if (method === 8 && typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('deflate-raw');
      const ab = await new Response(
        new Blob([compSlice]).stream().pipeThrough(ds)
      ).arrayBuffer();
      return { romName: cleanName, romUint8: new Uint8Array(ab) };
    }
    if (method === 8 && typeof process !== 'undefined' &&
        process.versions?.node) {
      const zlib = await import('node:zlib');
      const inf = zlib.inflateRawSync(compSlice);
      return { romName: cleanName, romUint8: new Uint8Array(inf) };
    }
  }
  return null;
}

export async function extractArchiveViaServer(
  u8, fileName, roomCode = 'NOVA', state = null
) {
  const authQ = state?.roomAuth
    ? `&auth=${encodeURIComponent(state.roomAuth)}` : '';
  const q = `name=${encodeURIComponent(fileName)}&room=${encodeURIComponent(
    roomCode || 'NOVA'
  )}${authQ}`;
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (state?.roomAuth) headers['X-Room-Auth'] = state.roomAuth;
  const url = state ? buildApiUrl(state, `/api/extract-rom?${q}`)
    : `/api/extract-rom?${q}`;
  const res = await fetch(url, { method: 'POST', headers, body: u8 });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  const hdrName = res.headers.get('X-Rom-Filename');
  const romName = hdrName ? decodeURIComponent(hdrName) : 'Game.nes';
  const serverCachedCrc = res.headers.get('X-Rom-Crc32') || null;
  return {
    romName, romUint8: new Uint8Array(await res.arrayBuffer()), serverCachedCrc
  };
}

export async function unpackRomIfNeeded(
  u8, fileName, roomCode = 'NOVA', state = null
) {
  if (!isArchiveNameOrMagic(fileName, u8)) {
    return { romName: fileName, romUint8: u8 };
  }
  if (String(fileName).toLowerCase().endsWith('.zip') ||
      (u8[0] === 0x50 && u8[1] === 0x4b)) {
    try {
      const zipRes = await extractRomFromZipBrowser(u8);
      if (zipRes) return zipRes;
    } catch {}
    if (u8.byteLength >= 30 && u8[0] === 0x50 && u8[1] === 0x4b) {
      if (isLocalHostRuntime() && u8.byteLength < 64 * 1024 * 1024 &&
          typeof fetch === 'function') {
        try {
          return await extractArchiveViaServer(u8, fileName, roomCode, state);
        } catch {}
      }
      return { romName: baseName(fileName), romUint8: u8 };
    }
  }
  return extractArchiveViaServer(u8, fileName, roomCode, state);
}
