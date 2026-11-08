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
  return (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03) ||
    (u8[0] === 0x52 && u8[1] === 0x61 && u8[2] === 0x72) ||
    (u8[0] === 0x37 && u8[1] === 0x7a && u8[2] === 0xbc);
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
    const start = localOff + 30 + dv.getUint16(localOff + 26, true) +
      dv.getUint16(localOff + 28, true);
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
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
    body: u8
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  const hdrName = res.headers.get('X-Rom-Filename');
  const romName = hdrName ? decodeURIComponent(hdrName) : 'Game.nes';
  return { romName, romUint8: new Uint8Array(await res.arrayBuffer()) };
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
      if (typeof window !== 'undefined' && u8.byteLength < 2 * 1024 * 1024 &&
          typeof fetch === 'function') {
        try { return await extractArchiveViaServer(u8, fileName); } catch {}
      }
      return { romName: baseName(fileName), romUint8: u8 };
    }
  }
  return extractArchiveViaServer(u8, fileName);
}

export async function fetchRomBytesWithProgress(
  url, label, fileName, ui, onProgress = null
) {
  ui.showScreenBanner(`${label} "${fileName}" (0%)...`, 'warn', 0);
  const res = await fetch(url);
  if (!res.ok) return null;
  const hdr = res.headers.get('X-Rom-Filename');
  const rName = hdr ? decodeURIComponent(hdr) : fileName;
  const total = Number(
    res.headers.get('X-Raw-Length') || res.headers.get('Content-Length')
  ) || 0;
  if (total > 65536 && res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const parts = [];
    let loaded = 0;
    let lastPct = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.length;
      const pct = Math.min(99, Math.round((loaded / total) * 100));
      if (pct >= lastPct + 4) {
        lastPct = pct;
        ui.showScreenBanner(`${label} "${rName}" (${pct}%)...`, 'warn', 0);
        if (onProgress) onProgress(pct);
      }
    }
    const out = new Uint8Array(loaded);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return { romName: rName, u8: out };
  }
  const buf = await res.arrayBuffer();
  return { romName: rName, u8: new Uint8Array(buf) };
}

export async function streamRomToPeer(
  state, ui, sessionId, syncState, uint8ToBase64
) {
  const chunkSize = 64 * 1024;
  const totalBytes = state.romUint8.length;
  const totalChunks = Math.ceil(totalBytes / chunkSize);
  const kb = Math.round(totalBytes / 1024);
  const localRomKey =
    typeof window !== 'undefined' ? state.localServerRomKey || null : null;
  const setBtn = (txt, dis = true) => {
    if (!ui.sendRomManualBtn) return;
    ui.sendRomManualBtn.textContent = txt;
    ui.sendRomManualBtn.disabled = dis;
  };
  setBtn('Sending... 0%', true);
  ui.logDebug(`Sending ROM "${state.romName}" (${kb} KB, ${totalChunks}ch)`);
  ui.showScreenBanner(`SENDING "${state.romName}" (0%)...`, 'warn', 0);
  ui.updateStatusStrip();
  state.ws.send(JSON.stringify({
    type: 'rom_chunk_start', sessionId, localRomKey,
    romName: state.romName, romCrc32: state.romCrc32,
    isAutoDefaultRom: state.isAutoDefaultRom,
    totalBytes, totalChunks, syncState
  }));
  if (localRomKey) return;
  let lastPct = 0;
  for (let i = 0; i < totalChunks; i++) {
    if (!state.ws || state.ws.readyState !== 1) return;
    while (totalChunks > 4 && state.ws?.readyState === 1 &&
           state.ws.bufferedAmount > 512 * 1024) {
      await new Promise((r) => setTimeout(r, 4));
    }
    const end = Math.min(totalBytes, (i + 1) * chunkSize);
    const slice = state.romUint8.subarray(i * chunkSize, end);
    state.ws.send(JSON.stringify({
      type: 'rom_chunk_data', sessionId, index: i,
      dataB64: uint8ToBase64(slice)
    }));
    const pct = Math.min(99, Math.round(((i + 1) / totalChunks) * 100));
    if (totalChunks > 4 && pct >= lastPct + 4) {
      lastPct = pct;
      setBtn(`Sending... ${pct}%`, true);
      ui.showScreenBanner(`SENDING "${state.romName}" (${pct}%)...`, 'warn', 0);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'rom_chunk_end', sessionId }));
    setBtn('Sent 100% (Syncing...)', false);
  }
}

export function handleRomTransferMessage(
  msg, state, ui, romSync, applyImportedSyncState, sendWs, base64ToUint8
) {
  if (msg.type === 'rom_transfer_progress') {
    if (ui.sendRomManualBtn) {
      ui.sendRomManualBtn.textContent = `Sending... ${msg.pct}%`;
    }
    ui.showScreenBanner(`SENDING "${state.romName}" (${msg.pct}%)`, 'warn', 0);
    return true;
  }
  if (msg.type === 'rom_chunk_start') {
    if (state.engine) state.engine.syncPaused = true;
    ui.showScreenBanner(`DOWNLOADING "${msg.romName}" (0%)...`, 'warn', 0);
    ui.updateStatusStrip();
    if (msg.localRomKey && typeof window !== 'undefined') {
      const url = `/api/local-rom?file=${encodeURIComponent(msg.localRomKey)}`;
      fetchRomBytesWithProgress(url, 'DOWNLOADING', msg.romName, ui, (pct) => {
        sendWs({ type: 'rom_transfer_progress', pct });
      }).then(async (loaded) => {
        if (!loaded) return;
        state.localServerRomKey = msg.localRomKey;
        await romSync.loadRomFromUint8(loaded.u8, msg.romName, {
          broadcastToPeer: false, isAutoDefault: Boolean(msg.isAutoDefaultRom),
          dropdownKey: msg.localRomKey
        });
        state.partnerRomName = msg.romName;
        state.partnerRomCrc32 = state.romCrc32;
        applyImportedSyncState(
          msg.syncState, `ONLINE SYNCED - PLAYING "${state.romName}"`
        );
      });
      return true;
    }
    state.incomingRomTransfer = {
      sessionId: msg.sessionId, romName: msg.romName, romCrc32: msg.romCrc32,
      isAutoDefaultRom: Boolean(msg.isAutoDefaultRom),
      totalBytes: msg.totalBytes, totalChunks: msg.totalChunks,
      syncState: msg.syncState, chunks: new Map(), endSeen: false, lastPct: 0
    };
    return true;
  }
  const xfer = state.incomingRomTransfer;
  const finalize = async () => {
    if (!xfer) return;
    state.incomingRomTransfer = null;
    const full = new Uint8Array(xfer.totalBytes);
    let offset = 0;
    for (let i = 0; i < xfer.totalChunks; i++) {
      const part = xfer.chunks.get(i);
      if (!part) return;
      full.set(part, offset);
      offset += part.length;
    }
    await romSync.loadRomFromUint8(full, xfer.romName, {
      broadcastToPeer: false, isAutoDefault: xfer.isAutoDefaultRom
    });
    state.partnerRomName = xfer.romName;
    state.partnerRomCrc32 = state.romCrc32;
    applyImportedSyncState(
      xfer.syncState, `ONLINE SYNCED - PLAYING "${state.romName}"`
    );
  };
  if (
    msg.type === 'rom_chunk_data' && xfer && msg.sessionId === xfer.sessionId
  ) {
    xfer.chunks.set(msg.index, base64ToUint8(msg.dataB64));
    const pct = Math.min(
      99, Math.round((xfer.chunks.size / xfer.totalChunks) * 100)
    );
    if (xfer.totalChunks > 8 && pct >= xfer.lastPct + 5) {
      xfer.lastPct = pct;
      ui.showScreenBanner(
        `DOWNLOADING "${xfer.romName}" (${pct}%)...`, 'warn', 0
      );
      sendWs({ type: 'rom_transfer_progress', pct });
    }
    if (xfer.chunks.size >= xfer.totalChunks && xfer.endSeen) finalize();
    return true;
  }
  if (
    msg.type === 'rom_chunk_end' && xfer && msg.sessionId === xfer.sessionId
  ) {
    xfer.endSeen = true;
    if (xfer.chunks.size >= xfer.totalChunks) finalize();
    return true;
  }
  return false;
}

export function setupRomDropAndPicker(state, ui, romSync) {
  const dropZone = document.getElementById('dropTarget');

  async function handleFileObject(file) {
    if (!file) return;
    try {
      const kb = Math.max(1, Math.round(file.size / 1024));
      ui.showScreenBanner(`LOADING "${file.name}" (${kb} KB)...`, 'warn', 0);
      const buf = await file.arrayBuffer();
      const rawU8 = new Uint8Array(buf);
      if (isArchiveNameOrMagic(file.name, rawU8)) {
        ui.showScreenBanner(`EXTRACTING "${file.name}"...`, 'warn', 0);
      }
      const { romName, romUint8 } = await unpackRomIfNeeded(rawU8, file.name);
      state.localServerRomKey = null;
      await romSync.loadRomFromUint8(romUint8, romName, {
        broadcastToPeer: true, isAutoDefault: false
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
    if (--dragDepth <= 0) {
      dragDepth = 0;
      if (dropZone) dropZone.classList.remove('drag-over');
    }
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    if (dropZone) dropZone.classList.remove('drag-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) await handleFileObject(f);
  });
}
