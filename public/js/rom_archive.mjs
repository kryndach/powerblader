// Client-Side ZIP Extractor, Striped HTTP Transfer & Drag-and-Drop Loader
import {
  isLocalHostRuntime, getCachedRomByCrc, formatTransferProgress,
  uploadRomToServerCache, fetchRomBytesWithProgress
} from './rom_fast_transfer.mjs';
import { bindRomDropAndPicker } from './transfer_status_ui.mjs';

export { uploadRomToServerCache, fetchRomBytesWithProgress };

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
  const serverCachedCrc = res.headers.get('X-Rom-Crc32') || null;
  return {
    romName, romUint8: new Uint8Array(await res.arrayBuffer()), serverCachedCrc
  };
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
      if (isLocalHostRuntime() && u8.byteLength < 64 * 1024 * 1024 &&
          typeof fetch === 'function') {
        try { return await extractArchiveViaServer(u8, fileName, roomCode); }
        catch {}
      }
      return { romName: baseName(fileName), romUint8: u8 };
    }
  }
  return extractArchiveViaServer(u8, fileName, roomCode);
}
export async function streamRomToPeer(
  state, ui, sessionId, syncState, uint8ToBase64, forceChunks = false
) {
  state.sendingRomSessionId = sessionId;
  const chunkSize = 64 * 1024, totalBytes = state.romUint8.length;
  const totalChunks = Math.ceil(totalBytes / chunkSize);
  const isP2p = Boolean(state.ws?.isServerlessP2p);
  const inBrw = !isP2p &&
    (typeof window !== 'undefined' || Boolean(state.apiBaseUrl)) &&
    typeof fetch === 'function';
  const localRomKey = !forceChunks && inBrw ? state.localServerRomKey : null;
  const setXfer = (phase, pct, info = null) => {
    const detail = formatTransferProgress(info || {
      pct, loadedBytes: Math.round((totalBytes * pct) / 100), totalBytes
    });
    if (ui.setTransferStatus) {
      ui.setTransferStatus({ phase, romName: state.romName, pct, detail });
    } else {
      ui.showScreenBanner(`SENDING "${state.romName}" (${detail})`, 'warn', 0);
    }
  };
  setXfer(localRomKey ? 'sending' : 'uploading', 0, {
    pct: 0, loadedBytes: 0, totalBytes
  });
  const roomRomKey = !forceChunks && !localRomKey && inBrw
    ? await uploadRomToServerCache(
      state, (pct, info) => setXfer('uploading', pct, info)
    ) : null;
  if (state.sendingRomSessionId !== sessionId || state.ws?.readyState !== 1)
    return ui.resetSendRomButtons?.();
  state.ws.send(JSON.stringify({
    type: 'rom_chunk_start', sessionId, localRomKey, roomRomKey,
    romName: state.romName, romCrc32: state.romCrc32,
    isAutoDefaultRom: state.isAutoDefaultRom,
    totalBytes, totalChunks, syncState
  }));
  if (localRomKey || roomRomKey) {
    return setXfer('sending', 0, { pct: 0, loadedBytes: 0, totalBytes });
  }
  const t0 = performance.now();
  let lastUiAt = 0;
  for (let i = 0; i < totalChunks; i++) {
    if (state.ws?.readyState !== 1 ||
        state.sendingRomSessionId !== sessionId) return;
    while (totalChunks > 4 && state.ws?.readyState === 1 &&
           state.ws.bufferedAmount > 256 * 1024)
      await new Promise((r) => setTimeout(r, 6));
    const endOff = Math.min(totalBytes, (i + 1) * chunkSize);
    const slice = state.romUint8.subarray(i * chunkSize, endOff);
    state.ws.send(JSON.stringify({
      type: 'rom_chunk_data', sessionId, index: i,
      dataB64: uint8ToBase64(slice)
    }));
    const now = performance.now();
    if (i === 0 || now - lastUiAt >= 150) {
      lastUiAt = now;
      const pct = Math.max(1, Math.min(99, Math.round(
        (endOff / totalBytes) * 100
      )));
      const bps = Math.round(endOff / Math.max(0.05, (now - t0) / 1000));
      setXfer('sending', pct, { pct, loadedBytes: endOff, totalBytes, bps });
      if (totalChunks > 4) await new Promise((r) => setTimeout(r, 4));
    }
  }
  if (state.ws?.readyState === 1 && state.sendingRomSessionId === sessionId) {
    state.ws.send(JSON.stringify({ type: 'rom_chunk_end', sessionId }));
    setXfer('partner-core', 100, { pct: 100 });
  }
}
export function handleRomTransferMessage(
  msg, state, ui, romSync, applyImportedSyncState, sendWs, base64ToUint8
) {
  if (msg.type === 'rom_transfer_progress') {
    if (!state.sendingRomSessionId ||
        (state.matchStarted && !state.engine?.syncPaused)) return true;
    const isCore = msg.stage === 'loading-core' || msg.pct >= 100;
    const phase = isCore ? 'partner-core' : 'sending';
    const pct = Math.max(0, Math.min(100, Math.round(Number(msg.pct) || 0)));
    const detail = msg.stage === 'cache-hit'
      ? 'Loaded from cache (0 KB)!'
      : msg.stage === 'loading-core'
        ? `Loading Emulator Engine (${formatTransferProgress(msg)})`
        : msg.pct >= 100 ? 'Starting game at Frame #0...'
          : formatTransferProgress(msg);
    if (ui.setTransferStatus) {
      ui.setTransferStatus({ phase, romName: state.romName, pct, detail });
    } else {
      ui.showScreenBanner(`SENDING "${state.romName}" - ${detail}`, 'warn', 0);
    }
    return true;
  }
  const finishLoad = async (u8, rName, autoDef, dropKey, syncSt) => {
    state.activeRomAbortCtrl = null; state.activeRomDownload = null;
    ui.setTransferStatus?.({
      phase: 'loading-core', romName: rName, pct: 100,
      detail: 'Starting emulator...'
    });
    await romSync.loadRomFromUint8(u8, rName, {
      broadcastToPeer: false, isAutoDefault: Boolean(autoDef),
      dropdownKey: dropKey || rName, reportPeerCoreProgress: true
    });
    state.partnerRomName = rName; state.partnerRomCrc32 = state.romCrc32;
    applyImportedSyncState(syncSt, `ONLINE SYNCED - PLAYING "${rName}"`);
  };
  const applyCacheHit = (hit, dropKey, syncSt) => {
    sendWs({ type: 'rom_transfer_progress', stage: 'cache-hit', pct: 100 });
    ui.logDebug?.(`ROM CRC32 ${msg.romCrc32} cache hit - 0 KB downloaded!`);
    return finishLoad(
      hit.u8, msg.romName, msg.isAutoDefaultRom, dropKey, syncSt
    );
  };
  if (msg.type === 'rom_chunk_start') {
    const act = state.activeRomDownload;
    if (act && msg.romCrc32 && act.romCrc32 === msg.romCrc32 &&
        state.activeRomAbortCtrl && !state.activeRomAbortCtrl.signal.aborted) {
      act.syncState = msg.syncState;
      const last = act.lastInfo || { pct: 1 };
      sendWs({ type: 'rom_transfer_progress', ...last });
      return true;
    }
    state.activeRomAbortCtrl?.abort(); state.activeRomDownload = null;
    if (state.engine) state.engine.syncPaused = true;
    const initDet = formatTransferProgress({
      pct: 0, loadedBytes: 0, totalBytes: msg.totalBytes || 0
    });
    if (ui.setTransferStatus) {
      ui.setTransferStatus({
        phase: 'downloading', romName: msg.romName, pct: 0, detail: initDet
      });
    } else {
      ui.showScreenBanner(`DOWNLOADING "${msg.romName}" (0%)...`, 'warn', 0);
      ui.updateStatusStrip();
    }
    const base = state.apiBaseUrl || '';
    if ((msg.localRomKey || msg.roomRomKey) &&
        (typeof window !== 'undefined' || Boolean(base))) {
      const ctrl = typeof AbortController === 'function'
        ? new AbortController() : null;
      state.activeRomAbortCtrl = ctrl;
      const dlSt = {
        romCrc32: msg.romCrc32, syncState: msg.syncState, lastInfo: null
      };
      state.activeRomDownload = dlSt;
      const authQ = state.roomAuth
        ? `&auth=${encodeURIComponent(state.roomAuth)}` : '';
      const q = `room=${encodeURIComponent(msg.roomRomKey)}` +
        `&crc=${encodeURIComponent(msg.romCrc32 || '')}${authQ}`;
      const fKey = encodeURIComponent(msg.localRomKey || '');
      const url = msg.localRomKey
        ? `${base}/api/local-rom?file=${fKey}${authQ}`
        : `${base}/api/room-rom?${q}`;
      const fb = () => {
        state.activeRomDownload = null;
        sendWs({ type: 'rom_request', haveCrc32: null, forceChunks: true });
      };
      (async () => {
        const hit = msg.romCrc32 ? await getCachedRomByCrc(msg.romCrc32) : null;
        if (hit?.u8) return applyCacheHit(hit, msg.localRomKey, dlSt.syncState);
        const r = await fetchRomBytesWithProgress(
          url, 'DOWNLOADING', msg.romName, ui,
          (pct, info) => {
            const pObj = { stage: 'downloading', pct, ...(info || {}) };
            dlSt.lastInfo = pObj;
            sendWs({ type: 'rom_transfer_progress', ...pObj });
          }, ctrl?.signal
        );
        return r ? finishLoad(
          r.u8, msg.romName, msg.isAutoDefaultRom,
          msg.localRomKey, dlSt.syncState
        ) : fb();
      })().catch((e) => { if (e?.name !== 'AbortError') fb(); });
      return true;
    }
    state.incomingRomTransfer = {
      sessionId: msg.sessionId, romName: msg.romName, romCrc32: msg.romCrc32,
      isAutoDefaultRom: Boolean(msg.isAutoDefaultRom),
      totalBytes: msg.totalBytes, totalChunks: msg.totalChunks,
      syncState: msg.syncState, chunks: new Map(), endSeen: false,
      t0: performance.now(), lastUiAt: 0
    };
    if (msg.romCrc32) {
      getCachedRomByCrc(msg.romCrc32).then((hit) => {
        const cur = state.incomingRomTransfer;
        if (!hit?.u8 || cur?.sessionId !== msg.sessionId) return;
        state.incomingRomTransfer = null;
        applyCacheHit(hit, null, msg.syncState);
      }).catch(() => {});
    }
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
    const now = performance.now();
    if (xfer.chunks.size === 1 || now - xfer.lastUiAt >= 180) {
      xfer.lastUiAt = now;
      const loadedBytes = Math.min(xfer.totalBytes, xfer.chunks.size * 65536);
      const pct = Math.max(1, Math.min(99, Math.round(
        (xfer.chunks.size / xfer.totalChunks) * 100
      )));
      const bps = Math.round(
        loadedBytes / Math.max(0.05, (now - xfer.t0) / 1000)
      );
      const pObj = {
        stage: 'downloading', pct, loadedBytes, totalBytes: xfer.totalBytes, bps
      };
      sendWs({ type: 'rom_transfer_progress', ...pObj });
      if (ui.setTransferStatus) {
        ui.setTransferStatus({
          phase: 'downloading', romName: xfer.romName, pct,
          detail: formatTransferProgress(pObj)
        });
      }
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
export const setupRomDropAndPicker = (state, ui, romSync) =>
  bindRomDropAndPicker(state, ui, romSync, unpackRomIfNeeded);
