// Client-Side ZIP Extractor, Server Archive (.rar/.7z) Bridge & Drag-and-Drop
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
  for (let i = u8.byteLength - 22; i >= Math.max(0, u8.byteLength - 65557); i--)
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const totalEntries = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true), decoder = new TextDecoder('utf-8');
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
    if (method === 0)
      return { romName: cleanName, romUint8: new Uint8Array(compSlice) };
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
export async function extractArchiveViaServer(u8, fileName, roomCode = 'NOVA') {
  const q = `name=${encodeURIComponent(fileName)}&room=${encodeURIComponent(
    roomCode || 'NOVA'
  )}`;
  const res = await fetch(`/api/extract-rom?${q}`, {
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
export async function unpackRomIfNeeded(u8, fileName, roomCode = 'NOVA') {
  if (!isArchiveNameOrMagic(fileName, u8))
    return { romName: fileName, romUint8: u8 };
  if (String(fileName).toLowerCase().endsWith('.zip') ||
      (u8[0] === 0x50 && u8[1] === 0x4b)) {
    try {
      const zipRes = await extractRomFromZipBrowser(u8);
      if (zipRes) return zipRes;
    } catch {}
    if (u8.byteLength >= 30 && u8[0] === 0x50 && u8[1] === 0x4b) {
      if (typeof window !== 'undefined' && u8.byteLength < 32 * 1024 * 1024 &&
          typeof fetch === 'function') {
        try { return await extractArchiveViaServer(u8, fileName, roomCode); }
        catch {}
      }
      return { romName: baseName(fileName), romUint8: u8 };
    }
  }
  return extractArchiveViaServer(u8, fileName, roomCode);
}
export async function uploadRomToServerCache(state) {
  if (typeof window === 'undefined' || typeof fetch !== 'function' ||
      !state.romUint8 || !state.romCrc32) return null;
  const rm = state.roomCode || 'NOVA', crc = state.romCrc32;
  if (state.roomRomUploadedCrc === crc) return rm;
  if (state.roomRomUploadPromise && state.roomRomUploadingCrc === crc)
    return state.roomRomUploadPromise;
  state.roomRomUploadingCrc = crc;
  state.roomRomUploadPromise = (async () => {
    try {
      let body = state.romUint8;
      const headers = { 'Content-Type': 'application/octet-stream' };
      const isZip = String(state.romName).toLowerCase().endsWith('.zip');
      if (typeof CompressionStream === 'function' &&
          body.byteLength > 16384 && !isZip) {
        const s = new Blob([body]).stream().pipeThrough(
          new CompressionStream('gzip')
        );
        body = new Uint8Array(await new Response(s).arrayBuffer());
        headers['X-Rom-Encoding'] = 'gzip';
      }
      const q = `room=${encodeURIComponent(rm)}&crc=${encodeURIComponent(
        crc
      )}&name=${encodeURIComponent(state.romName)}`;
      const r = await fetch(`/api/room-rom?${q}`, {
        method: 'POST', headers, body
      });
      if (r.ok) { state.roomRomUploadedCrc = crc; return rm; }
    } catch {}
    return null;
  })();
  return state.roomRomUploadPromise;
}
export async function fetchRomBytesWithProgress(
  url, label, fileName, ui, onProgress = null, signal = null
) {
  ui.showScreenBanner(`${label} "${fileName}" (0%)...`, 'warn', 8000);
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) return null;
  const hdr = res.headers.get('X-Rom-Filename');
  const rName = hdr ? decodeURIComponent(hdr) : fileName;
  const total = Number(
    res.headers.get('X-Raw-Length') || res.headers.get('Content-Length')
  ) || 0;
  if (total > 65536 && res.body?.getReader) {
    const reader = res.body.getReader(), parts = [];
    let loaded = 0, lastPct = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); loaded += value.length;
      const pct = Math.min(99, Math.round((loaded / total) * 100));
      if (pct >= lastPct + 4) {
        lastPct = pct; onProgress?.(pct);
        ui.showScreenBanner(`${label} "${rName}" (${pct}%)...`, 'warn', 8000);
      }
    }
    const out = new Uint8Array(loaded);
    for (let i = 0, off = 0; i < parts.length; i++) {
      out.set(parts[i], off); off += parts[i].length;
    }
    onProgress?.(100);
    return { romName: rName, u8: out };
  }
  const u8 = new Uint8Array(await res.arrayBuffer());
  onProgress?.(100);
  return { romName: rName, u8 };
}
export async function streamRomToPeer(
  state, ui, sessionId, syncState, uint8ToBase64, forceChunks = false
) {
  state.sendingRomSessionId = sessionId;
  const chunkSize = 64 * 1024, totalBytes = state.romUint8.length;
  const totalChunks = Math.ceil(totalBytes / chunkSize);
  const inBrw = typeof window !== 'undefined' && typeof fetch === 'function';
  const localRomKey = !forceChunks && inBrw ? state.localServerRomKey : null;
  const setBtn = (txt, dis = false) => {
    for (const b of [ui.sendRomManualBtn, ui.topSendRomBtn])
      if (b) { b.textContent = txt; b.disabled = dis; }
  };
  setBtn('Sending ROM...', true);
  ui.showScreenBanner(`SENDING "${state.romName}"...`, 'warn', 8000);
  ui.updateStatusStrip();
  const roomRomKey = !forceChunks && !localRomKey && inBrw
    ? await uploadRomToServerCache(state) : null;
  if (state.sendingRomSessionId !== sessionId || state.ws?.readyState !== 1)
    return ui.resetSendRomButtons?.();
  state.ws.send(JSON.stringify({
    type: 'rom_chunk_start', sessionId, localRomKey, roomRomKey,
    romName: state.romName, romCrc32: state.romCrc32,
    isAutoDefaultRom: state.isAutoDefaultRom,
    totalBytes, totalChunks, syncState
  }));
  if (localRomKey || roomRomKey) return setBtn('Partner DL...', false);
  for (let i = 0, lastPct = 0; i < totalChunks; i++) {
    if (state.ws?.readyState !== 1 ||
        state.sendingRomSessionId !== sessionId) return;
    while (totalChunks > 4 && state.ws?.readyState === 1 &&
           state.ws.bufferedAmount > 256 * 1024)
      await new Promise((r) => setTimeout(r, 6));
    const slice = state.romUint8.subarray(
      i * chunkSize, Math.min(totalBytes, (i + 1) * chunkSize)
    );
    state.ws.send(JSON.stringify({
      type: 'rom_chunk_data', sessionId, index: i,
      dataB64: uint8ToBase64(slice)
    }));
    const pct = Math.min(99, Math.round(((i + 1) / totalChunks) * 100));
    if (totalChunks > 4 && (pct >= lastPct + 4 || i % 2 === 1)) {
      lastPct = pct; setBtn(`Sending ${pct}%`, true);
      ui.showScreenBanner(`SENDING "${state.romName}" (${pct}%)`, 'warn', 6000);
      await new Promise((r) => setTimeout(r, 4));
    }
  }
  if (state.ws?.readyState === 1 && state.sendingRomSessionId === sessionId) {
    state.ws.send(JSON.stringify({ type: 'rom_chunk_end', sessionId }));
    ui.resetSendRomButtons?.();
  }
}
export function handleRomTransferMessage(
  msg, state, ui, romSync, applyImportedSyncState, sendWs, base64ToUint8
) {
  if (msg.type === 'rom_transfer_progress') {
    if (!state.sendingRomSessionId ||
        (state.matchStarted && !state.engine?.syncPaused)) return true;
    if (msg.pct >= 100) { ui.resetSendRomButtons?.(); return true; }
    if (ui.sendRomManualBtn)
      ui.sendRomManualBtn.textContent = `Partner DL ${msg.pct}%`;
    if (ui.topSendRomBtn) ui.topSendRomBtn.textContent = `DL ${msg.pct}%`;
    ui.showScreenBanner(
      `PARTNER DOWNLOADING "${state.romName}" (${msg.pct}%)`, 'warn', 5000
    );
    return true;
  }
  const finishLoad = async (u8, rName, autoDef, dropKey, syncSt) => {
    state.activeRomAbortCtrl = null;
    await romSync.loadRomFromUint8(u8, rName, {
      broadcastToPeer: false, isAutoDefault: Boolean(autoDef),
      dropdownKey: dropKey || rName
    });
    state.partnerRomName = rName; state.partnerRomCrc32 = state.romCrc32;
    applyImportedSyncState(syncSt, `ONLINE SYNCED - PLAYING "${rName}"`);
  };
  if (msg.type === 'rom_chunk_start') {
    state.activeRomAbortCtrl?.abort();
    if (state.engine) state.engine.syncPaused = true;
    ui.showScreenBanner(`DOWNLOADING "${msg.romName}" (0%)...`, 'warn', 8000);
    ui.updateStatusStrip();
    if ((msg.localRomKey || msg.roomRomKey) && typeof window !== 'undefined') {
      const ctrl = typeof AbortController === 'function'
        ? new AbortController() : null;
      state.activeRomAbortCtrl = ctrl;
      const q = `room=${encodeURIComponent(
        msg.roomRomKey
      )}&crc=${encodeURIComponent(msg.romCrc32 || '')}`;
      const url = msg.localRomKey
        ? `/api/local-rom?file=${encodeURIComponent(msg.localRomKey)}`
        : `/api/room-rom?${q}`;
      const fb = () =>
        sendWs({ type: 'rom_request', haveCrc32: null, forceChunks: true });
      fetchRomBytesWithProgress(
        url, 'DOWNLOADING', msg.romName, ui,
        (pct) => sendWs({ type: 'rom_transfer_progress', pct }), ctrl?.signal
      ).then((r) => r ? finishLoad(
        r.u8, msg.romName, msg.isAutoDefaultRom, msg.localRomKey, msg.syncState
      ) : fb()).catch((e) => { if (e?.name !== 'AbortError') fb(); });
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
      full.set(part, off); off += part.length;
    }
    return finishLoad(
      full, xfer.romName, xfer.isAutoDefaultRom, null, xfer.syncState
    );
  };
  if (msg.type === 'rom_chunk_data' && xfer?.sessionId === msg.sessionId) {
    xfer.chunks.set(msg.index, base64ToUint8(msg.dataB64));
    const pct = Math.min(99, Math.round(
      (xfer.chunks.size / xfer.totalChunks) * 100
    ));
    if (xfer.totalChunks > 8 && pct >= xfer.lastPct + 5) {
      xfer.lastPct = pct; sendWs({ type: 'rom_transfer_progress', pct });
      ui.showScreenBanner(
        `DOWNLOADING "${xfer.romName}" (${pct}%)`, 'warn', 6000
      );
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
  const dz = document.getElementById('dropTarget');
  async function loadFile(file) {
    if (!file) return;
    try {
      const kb = Math.max(1, Math.round(file.size / 1024));
      ui.showScreenBanner(`LOADING "${file.name}" (${kb} KB)...`, 'warn', 6000);
      const rawU8 = new Uint8Array(await file.arrayBuffer());
      const { romName, romUint8 } = await unpackRomIfNeeded(
        rawU8, file.name, state.roomCode
      );
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
    const f = e.target.files?.[0]; e.target.value = ''; if (f) loadFile(f);
  });
  let d = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); d = Math.max(0, d) + 1; dz?.classList.add('drag-over');
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault(); if (--d <= 0) dz?.classList.remove('drag-over');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); d = 0; dz?.classList.remove('drag-over');
    if (e.dataTransfer?.files?.[0]) loadFile(e.dataTransfer.files[0]);
  });
}
