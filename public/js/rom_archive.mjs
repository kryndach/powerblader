// Client-Side ZIP Extractor, Server Archive (.rar/.7z) Bridge & Drag-and-Drop
const ROM_EXTS = [
  '.nes', '.sfc', '.smc', '.fig', '.swc',
  '.md', '.gen', '.smd', '.bin', '.sms', '.gg', '.3ds'
];
const ARCHIVE_EXTS = ['.zip', '.rar', '.7z'];

function isRomEntryName(name = '') {
  const lower = String(name).trim().toLowerCase();
  return ROM_EXTS.some((ext) => lower.endsWith(ext));
}

function isArchiveNameOrMagic(name = '', u8 = null) {
  const lower = String(name).trim().toLowerCase();
  if (ARCHIVE_EXTS.some((ext) => lower.endsWith(ext))) return true;
  if (!u8 || u8.length < 6) return false;
  // ZIP (PK\x03\x04), RAR (Rar!), 7z (7z\xBC\xAF\x27\x1C)
  if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) {
    return true;
  }
  if (u8[0] === 0x52 && u8[1] === 0x61 && u8[2] === 0x72 && u8[3] === 0x21) {
    return true;
  }
  if (u8[0] === 0x37 && u8[1] === 0x7a && u8[2] === 0xbc && u8[3] === 0xaf) {
    return true;
  }
  return false;
}

function baseName(entryPath) {
  const parts = String(entryPath).replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'Game.nes';
}

export async function extractRomFromZipBrowser(u8) {
  if (!u8 || u8.byteLength < 30) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) return null;

  let eocd = -1;
  const minPos = Math.max(0, u8.byteLength - 65557);
  for (let i = u8.byteLength - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const totalEntries = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');

  for (let e = 0; e < totalEntries && cdOff + 46 <= u8.byteLength; e++) {
    if (dv.getUint32(cdOff, true) !== 0x02014b50) break;
    const method = dv.getUint16(cdOff + 10, true);
    const compSize = dv.getUint32(cdOff + 20, true);
    const nameLen = dv.getUint16(cdOff + 28, true);
    const extraLen = dv.getUint16(cdOff + 30, true);
    const commentLen = dv.getUint16(cdOff + 32, true);
    const localOff = dv.getUint32(cdOff + 42, true);
    const rawName = decoder.decode(
      u8.subarray(cdOff + 46, cdOff + 46 + nameLen)
    );
    cdOff += 46 + nameLen + extraLen + commentLen;

    const cleanName = baseName(rawName);
    if (!isRomEntryName(cleanName)) continue;
    if (cleanName.toLowerCase().endsWith('.bin') && totalEntries > 1) continue;
    if (localOff + 30 > u8.byteLength) continue;
    if (dv.getUint32(localOff, true) !== 0x04034b50) continue;

    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const compSlice = u8.subarray(start, start + compSize);

    if (method === 0) {
      return { romName: cleanName, romUint8: new Uint8Array(compSlice) };
    }
    if (method === 8) {
      if (typeof DecompressionStream === 'function') {
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([compSlice]).stream().pipeThrough(ds);
        const ab = await new Response(stream).arrayBuffer();
        return { romName: cleanName, romUint8: new Uint8Array(ab) };
      }
      if (typeof process !== 'undefined' && process.versions?.node) {
        const zlib = await import('node:zlib');
        const out = zlib.inflateRawSync(compSlice);
        return { romName: cleanName, romUint8: new Uint8Array(out) };
      }
    }
  }
  return null;
}

export async function extractArchiveViaServer(u8, fileName) {
  const url = `/api/extract-rom?name=${encodeURIComponent(fileName)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: u8
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  const hdrName = res.headers.get('X-Rom-Filename');
  const romName = hdrName ? decodeURIComponent(hdrName) : 'Game.nes';
  const buf = await res.arrayBuffer();
  return { romName, romUint8: new Uint8Array(buf) };
}

export async function unpackRomIfNeeded(u8, fileName) {
  if (!isArchiveNameOrMagic(fileName, u8)) {
    return { romName: fileName, romUint8: u8 };
  }
  const lower = String(fileName).toLowerCase();
  if (lower.endsWith('.zip') || (u8[0] === 0x50 && u8[1] === 0x4b)) {
    try {
      const zipRes = await extractRomFromZipBrowser(u8);
      if (zipRes) return zipRes;
    } catch {}
    if (u8.byteLength >= 30 && u8[0] === 0x50 && u8[1] === 0x4b) {
      return { romName: baseName(fileName), romUint8: u8 };
    }
  }
  return extractArchiveViaServer(u8, fileName);
}

export function setupRomDropAndPicker(state, ui, romSync) {
  const dropZone = document.getElementById('dropTarget');

  async function handleFileObject(file) {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const rawU8 = new Uint8Array(buf);
      if (isArchiveNameOrMagic(file.name, rawU8)) {
        ui.showScreenBanner(`EXTRACTING "${file.name}"...`, 'warn', 0);
      }
      const { romName, romUint8 } = await unpackRomIfNeeded(rawU8, file.name);
      await romSync.loadRomFromUint8(romUint8, romName, {
        broadcastToPeer: true,
        isAutoDefault: false
      });
    } catch (err) {
      ui.logDebug(`Archive/ROM load error: ${err.message}`);
      ui.showScreenBanner(`LOAD FAILED: ${err.message}`, 'err', 4000);
    }
  }

  if (ui.romFileInput) {
    ui.romFileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) await handleFileObject(file);
    });
  }

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    if (dropZone) dropZone.classList.add('drag-over');
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && dropZone) dropZone.classList.remove('drag-over');
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    if (dropZone) dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) await handleFileObject(file);
  });
}
