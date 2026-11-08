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
    if (localOff + 30 > u8.byteLength ||
        dv.getUint32(localOff, true) !== 0x04034b50) continue;
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
        return {
          romName: cleanName,
          romUint8: new Uint8Array(await new Response(stream).arrayBuffer())
        };
      }
      if (typeof process !== 'undefined' && process.versions?.node) {
        const zlib = await import('node:zlib');
        return {
          romName: cleanName,
          romUint8: new Uint8Array(zlib.inflateRawSync(compSlice))
        };
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
  if (String(fileName).toLowerCase().endsWith('.zip') ||
      (u8[0] === 0x50 && u8[1] === 0x4b)) {
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
  if (total > 65536 && res.body?.getReader) {
    const reader = res.body.getReader();
    const parts = [];
    let loaded = 0, lastPct = 0;
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
  return { romName: rName, u8: new Uint8Array(await res.arrayBuffer()) };
}

export async function streamRomToPeer(
  state, ui, sessionId, syncState, uint8ToBase64
) {
  const chunkSize = 64 * 1024, totalBytes = state.romUint8.length;
  const totalChunks = Math.ceil(totalBytes / chunkSize);
  const kb = Math.round(totalBytes / 1024);
  const inBrw = typeof window !== 'undefined' && typeof fetch === 'function';
  const localRomKey = inBrw ? state.localServerRomKey || null : null;
  const setBtn = (txt, dis = true) => {
    if (ui.sendRomManualBtn) {
      ui.sendRomManualBtn.textContent = txt;
      ui.sendRomManualBtn.disabled = dis;
    }
    if (ui.topSendRomBtn) {
      ui.topSendRomBtn.textContent = dis ? txt : 'Send ROM';
      ui.topSendRomBtn.disabled = dis;
    }
  };
  setBtn('Sending... 0%', true);
  ui.logDebug(`Sending ROM "${state.romName}" (${kb} KB, ${totalChunks}ch)`);
  ui.showScreenBanner(`SENDING "${state.romName}" (0%)...`, 'warn', 0);
  ui.updateStatusStrip();
  let roomRomKey = null;
  if (!localRomKey && inBrw) {
    try {
      const rm = state.roomCode || 'NOVA';
      const u = `/api/room-rom?room=${encodeURIComponent(
        rm
      )}&name=${encodeURIComponent(state.romName)}`;
      const r = await fetch(u, { method: 'POST', body: state.romUint8 });
      if (r.ok) roomRomKey = rm;
    } catch {}
  }
  state.ws.send(JSON.stringify({
    type: 'rom_chunk_start', sessionId, localRomKey, roomRomKey,
    romName: state.romName, romCrc32: state.romCrc32,
    isAutoDefaultRom: state.isAutoDefaultRom,
    totalBytes, totalChunks, syncState
  }));
  if (localRomKey || roomRomKey) return;
  for (let i = 0, lastPct = 0; i < totalChunks; i++) {
    if (state.ws?.readyState !== 1) return;
    while (totalChunks > 4 && state.ws?.readyState === 1 &&
           state.ws.bufferedAmount > 256 * 1024) {
      await new Promise((r) => setTimeout(r, 6));
    }
    const slice = state.romUint8.subarray(
      i * chunkSize, Math.min(totalBytes, (i + 1) * chunkSize)
    );
    state.ws.send(JSON.stringify({
      type: 'rom_chunk_data', sessionId, index: i,
      dataB64: uint8ToBase64(slice)
    }));
    const pct = Math.min(99, Math.round(((i + 1) / totalChunks) * 100));
    if (totalChunks > 4 && (pct >= lastPct + 4 || i % 2 === 1)) {
      lastPct = pct;
      setBtn(`Sending... ${pct}%`, true);
      ui.showScreenBanner(`SENDING "${state.romName}" (${pct}%)...`, 'warn', 0);
      await new Promise((r) => setTimeout(r, 4));
    }
  }
  if (state.ws?.readyState === 1) {
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
    if (ui.topSendRomBtn) ui.topSendRomBtn.textContent = `${msg.pct}%`;
    ui.showScreenBanner(`SENDING "${state.romName}" (${msg.pct}%)`, 'warn', 0);
    return true;
  }
  const finishRomLoad = async (u8, rName, autoDef, dropKey, syncSt) => {
    await romSync.loadRomFromUint8(u8, rName, {
      broadcastToPeer: false, isAutoDefault: Boolean(autoDef),
      dropdownKey: dropKey || rName
    });
    state.partnerRomName = rName;
    state.partnerRomCrc32 = state.romCrc32;
    applyImportedSyncState(syncSt, `ONLINE SYNCED - PLAYING "${rName}"`);
  };
  if (msg.type === 'rom_chunk_start') {
    if (state.engine) state.engine.syncPaused = true;
    ui.showScreenBanner(`DOWNLOADING "${msg.romName}" (0%)...`, 'warn', 0);
    ui.updateStatusStrip();
    if ((msg.localRomKey || msg.roomRomKey) && typeof window !== 'undefined') {
      const url = msg.localRomKey
        ? `/api/local-rom?file=${encodeURIComponent(msg.localRomKey)}`
        : `/api/room-rom?room=${encodeURIComponent(msg.roomRomKey)}`;
      fetchRomBytesWithProgress(url, 'DOWNLOADING', msg.romName, ui, (pct) =>
        sendWs({ type: 'rom_transfer_progress', pct })
      ).then((r) => r && finishRomLoad(
        r.u8, msg.romName, msg.isAutoDefaultRom, msg.localRomKey, msg.syncState
      ));
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
  const finalize = () => {
    if (!xfer) return;
    state.incomingRomTransfer = null;
    const full = new Uint8Array(xfer.totalBytes);
    for (let i = 0, off = 0; i < xfer.totalChunks; i++) {
      const part = xfer.chunks.get(i);
      if (!part) return;
      full.set(part, off);
      off += part.length;
    }
    return finishRomLoad(
      full, xfer.romName, xfer.isAutoDefaultRom, null, xfer.syncState
    );
  };
  if (msg.type === 'rom_chunk_data' && xfer &&
      msg.sessionId === xfer.sessionId) {
    xfer.chunks.set(msg.index, base64ToUint8(msg.dataB64));
    const pct = Math.min(
      99, Math.round((xfer.chunks.size / xfer.totalChunks) * 100)
    );
    if (xfer.totalChunks > 8 && pct >= xfer.lastPct + 5) {
      xfer.lastPct = pct;
      ui.showScreenBanner(`DOWNLOADING "${xfer.romName}" (${pct}%)`, 'warn', 0);
      sendWs({ type: 'rom_transfer_progress', pct });
    }
    if (xfer.chunks.size >= xfer.totalChunks && xfer.endSeen) finalize();
    return true;
  }
  if (msg.type === 'rom_chunk_end' && xfer?.sessionId === msg.sessionId) {
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
      const rawU8 = new Uint8Array(await file.arrayBuffer());
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
  ui.romFileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) handleFileObject(file);
  });
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    dropZone?.classList.add('drag-over');
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dropZone?.classList.remove('drag-over');
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropZone?.classList.remove('drag-over');
    if (e.dataTransfer?.files?.[0]) handleFileObject(e.dataTransfer.files[0]);
  });
}
