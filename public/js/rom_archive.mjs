// Striped HTTP/P2P ROM Transfer & Drag-and-Drop Loader Facade
import {
  getCachedRomByCrc, formatTransferProgress,
  uploadRomToServerCache, fetchRomBytesWithProgress, gzipBytes, gunzipBytes
} from './rom_fast_transfer.mjs';
import { bindRomDropAndPicker } from './transfer_status_ui.mjs';
import {
  extractRomFromZipBrowser, extractArchiveViaServer, unpackRomIfNeeded
} from './rom_zip_unpacker.mjs';
import {
  encodeBinaryRomChunk, matchesBinarySessionId
} from '../../src/binary_net_codec.mjs';

export {
  uploadRomToServerCache, fetchRomBytesWithProgress,
  extractRomFromZipBrowser, extractArchiveViaServer, unpackRomIfNeeded
};
export async function streamRomToPeer(
  state, ui, sessionId, syncState, uint8ToBase64, forceChunks = false
) {
  state.sendingRomSessionId = sessionId;
  state.peerAckedTransferSessionId = null;
  const isP2p = Boolean(state.ws?.isServerlessP2p);
  const inBrw = !isP2p &&
    (typeof window !== 'undefined' || Boolean(state.apiBaseUrl)) &&
    typeof fetch === 'function';
  const localRomKey = !forceChunks && inBrw ? state.localServerRomKey : null;
  let wireBytes = state.romUint8, payloadEncoding = 'identity';
  if (!localRomKey && (isP2p || forceChunks) && wireBytes.byteLength > 8192 &&
      !String(state.romName).toLowerCase().endsWith('.zip')) {
    try {
      const gz = await gzipBytes(wireBytes);
      if (gz.byteLength < wireBytes.byteLength * 0.92) {
        wireBytes = gz; payloadEncoding = 'gzip';
      }
    } catch {}
  }
  const chunkSize = isP2p ? 16384 : 65536, totalBytes = wireBytes.length;
  const totalChunks = Math.ceil(totalBytes / chunkSize);
  const setXfer = (phase, pct, info = null) => {
    const detail = formatTransferProgress(info || {
      pct, loadedBytes: Math.round((totalBytes * pct) / 100), totalBytes
    });
    if (ui.setTransferStatus) {
      ui.setTransferStatus({
        sessionId, phase, romName: state.romName, pct, detail
      });
    } else {
      ui.showScreenBanner(`SENDING "${state.romName}" (${detail})`, 'warn', 0);
    }
  };
  const alreadyUp = state.roomRomUploadedCrc === state.romCrc32;
  const initPhase = localRomKey || alreadyUp || isP2p || forceChunks
    ? 'sending' : 'uploading';
  setXfer(initPhase, 0, { pct: 0, loadedBytes: 0, totalBytes });
  const roomRomKey = !forceChunks && !localRomKey && inBrw
    ? await uploadRomToServerCache(
      state, (pct, info) => setXfer('uploading', pct, info)
    ) : null;
  if (state.sendingRomSessionId !== sessionId || state.ws?.readyState !== 1)
    return ui.resetSendRomButtons?.();
  state.ws.send(JSON.stringify({
    type: 'rom_chunk_start', sessionId, localRomKey, roomRomKey,
    romName: state.romName, romCrc32: state.romCrc32, payloadEncoding,
    isAutoDefaultRom: state.isAutoDefaultRom,
    totalBytes, totalChunks, syncState
  }));
  if (localRomKey || roomRomKey) {
    return setXfer('sending', 0, { pct: 0, loadedBytes: 0, totalBytes });
  }
  const t0 = performance.now(), maxBuf = isP2p ? 131072 : 262144;
  let lastUiAt = 0;
  for (let i = 0; i < totalChunks; i++) {
    if (state.ws?.readyState !== 1 ||
        state.sendingRomSessionId !== sessionId) return;
    while (totalChunks > 4 && state.ws?.readyState === 1 &&
           state.ws.bufferedAmount > maxBuf)
      await new Promise((r) => setTimeout(r, 8));
    const endOff = Math.min(totalBytes, (i + 1) * chunkSize);
    const slice = wireBytes.subarray(i * chunkSize, endOff);
    if (isP2p) {
      state.ws.send(encodeBinaryRomChunk(sessionId, i, slice));
    } else {
      state.ws.send(JSON.stringify({
        type: 'rom_chunk_data', sessionId, index: i,
        dataB64: uint8ToBase64(slice)
      }));
    }
    const now = performance.now();
    if (state.peerAckedTransferSessionId !== sessionId &&
        (i === 0 || now - lastUiAt >= 180)) {
      lastUiAt = now;
      const inFlight = isP2p
        ? (state.ws.bufferedAmount || 0)
        : Math.round((state.ws.bufferedAmount || 0) * 0.72);
      const sentEst = Math.max(0, endOff - inFlight);
      const pct = Math.max(1, Math.min(95, Math.round(
        (sentEst / totalBytes) * 100
      )));
      const bps = Math.round(sentEst / Math.max(0.05, (now - t0) / 1000));
      setXfer('sending', pct, { pct, loadedBytes: sentEst, totalBytes, bps });
      if (totalChunks > 4) await new Promise((r) => setTimeout(r, 4));
    }
  }
  while (state.ws?.readyState === 1 && state.ws.bufferedAmount > 8192 &&
         state.sendingRomSessionId === sessionId) {
    await new Promise((r) => setTimeout(r, 12));
  }
  if (state.ws?.readyState === 1 && state.sendingRomSessionId === sessionId) {
    state.ws.send(JSON.stringify({ type: 'rom_chunk_end', sessionId }));
    if (state.peerAckedTransferSessionId !== sessionId) {
      setXfer('partner-core', 0, { pct: 0 });
    }
  }
}
export function handleRomTransferMessage(
  msg, state, ui, romSync, applyImportedSyncState, sendWs, base64ToUint8
) {
  if (msg.type === 'rom_transfer_progress') {
    if (!state.sendingRomSessionId ||
        (msg.sessionId && msg.sessionId !== state.sendingRomSessionId) ||
        (state.matchStarted && !state.engine?.syncPaused)) return true;
    state.peerAckedTransferSessionId = state.sendingRomSessionId;
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
      ui.setTransferStatus({
        sessionId: state.sendingRomSessionId, phase,
        romName: state.romName, pct, detail
      });
    } else {
      ui.showScreenBanner(`SENDING "${state.romName}" - ${detail}`, 'warn', 0);
    }
    return true;
  }
  const finishLoad = async (u8, rName, autoDef, dropKey, syncSt) => {
    state.activeRomAbortCtrl = null; state.activeRomDownload = null;
    ui.setTransferStatus?.({
      phase: 'loading-core', romName: rName, pct: 0,
      detail: 'Starting emulator...'
    });
    await romSync.loadRomFromUint8(u8, rName, {
      broadcastToPeer: false, isAutoDefault: Boolean(autoDef),
      dropdownKey: dropKey || rName, reportPeerCoreProgress: true
    });
    state.partnerRomName = rName; state.partnerRomCrc32 = state.romCrc32;
    applyImportedSyncState(syncSt, `ONLINE SYNCED - PLAYING "${rName}"`);
  };
  const applyCacheHit = (hit, dropKey, syncSt, sid = '') => {
    sendWs({
      type: 'rom_transfer_progress', sessionId: sid,
      stage: 'cache-hit', pct: 0
    });
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
      sendWs({
        type: 'rom_transfer_progress', sessionId: msg.sessionId, ...last
      });
      return true;
    }
    state.activeRomAbortCtrl?.abort(); state.activeRomDownload = null;
    if (state.engine) state.engine.syncPaused = true;
    const initDet = formatTransferProgress({
      pct: 0, loadedBytes: 0, totalBytes: msg.totalBytes || 0
    });
    if (ui.setTransferStatus) {
      ui.setTransferStatus({
        sessionId: msg.sessionId, phase: 'downloading',
        romName: msg.romName, pct: 0, detail: initDet
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
        if (hit?.u8) {
          return applyCacheHit(
            hit, msg.localRomKey, dlSt.syncState, msg.sessionId
          );
        }
        const r = await fetchRomBytesWithProgress(
          url, 'DOWNLOADING', msg.romName, ui,
          (pct, info) => {
            const pObj = {
              sessionId: msg.sessionId, stage: 'downloading',
              pct, ...(info || {})
            };
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
      payloadEncoding: msg.payloadEncoding || 'identity',
      isAutoDefaultRom: Boolean(msg.isAutoDefaultRom),
      totalBytes: msg.totalBytes, totalChunks: msg.totalChunks,
      syncState: msg.syncState, chunks: new Map(), endSeen: false,
      receivedBytes: 0, t0: performance.now(), lastUiAt: 0
    };
    if (msg.romCrc32) {
      getCachedRomByCrc(msg.romCrc32).then((hit) => {
        const cur = state.incomingRomTransfer;
        if (!hit?.u8 || cur?.sessionId !== msg.sessionId) return;
        state.incomingRomTransfer = null;
        return applyCacheHit(hit, null, msg.syncState, msg.sessionId);
      }).catch(() => {});
    }
    return true;
  }
  const xfer = state.incomingRomTransfer;
  const finalize = async () => {
    if (!xfer) return;
    state.incomingRomTransfer = null;
    const full = new Uint8Array(xfer.totalBytes);
    for (let i = 0, off = 0; i < xfer.totalChunks; i++) {
      const part = xfer.chunks.get(i);
      if (!part) return;
      full.set(part, off); off += part.length;
    }
    const romBytes = xfer.payloadEncoding === 'gzip'
      ? await gunzipBytes(full) : full;
    sendWs({
      type: 'rom_transfer_progress', sessionId: xfer.sessionId,
      stage: 'loading-core', pct: 0
    });
    return finishLoad(
      romBytes, xfer.romName, xfer.isAutoDefaultRom, null, xfer.syncState
    );
  };
  const runFinalize = () => finalize().catch((e) => {
    ui.setTransferStatus?.(null);
    ui.logDebug?.(`ROM chunk finalize failed: ${e?.message || e}`);
    ui.showScreenBanner?.(
      `ROM TRANSFER FAILED: ${e?.message || 'Error'}`, 'err', 4000
    );
    if (state.engine) state.engine.syncPaused = false;
    ui.updateStatusStrip?.();
  });
  if (msg.type === 'rom_chunk_data' && xfer &&
      matchesBinarySessionId(msg.sessionId, xfer.sessionId)) {
    const part = msg.data instanceof Uint8Array
      ? msg.data : base64ToUint8(msg.dataB64);
    if (!xfer.chunks.has(msg.index)) {
      xfer.chunks.set(msg.index, part);
      xfer.receivedBytes += part.byteLength;
    }
    const now = performance.now();
    if (xfer.chunks.size === 1 || now - xfer.lastUiAt >= 180) {
      xfer.lastUiAt = now;
      const loadedBytes = Math.min(xfer.totalBytes, xfer.receivedBytes);
      const pct = Math.max(1, Math.min(99, Math.round(
        (loadedBytes / Math.max(1, xfer.totalBytes)) * 100
      )));
      const bps = Math.round(
        loadedBytes / Math.max(0.05, (now - xfer.t0) / 1000)
      );
      const pObj = {
        sessionId: xfer.sessionId, stage: 'downloading',
        pct, loadedBytes, totalBytes: xfer.totalBytes, bps
      };
      sendWs({ type: 'rom_transfer_progress', ...pObj });
      ui.setTransferStatus?.({
        sessionId: xfer.sessionId, phase: 'downloading', romName: xfer.romName,
        pct, detail: formatTransferProgress(pObj)
      });
    }
    if (xfer.chunks.size >= xfer.totalChunks && xfer.endSeen) runFinalize();
    return true;
  }
  if (msg.type === 'rom_chunk_end' && xfer?.sessionId === msg.sessionId) {
    xfer.endSeen = true;
    if (xfer.chunks.size >= xfer.totalChunks) runFinalize();
    return true;
  }
  return false;
}
export const setupRomDropAndPicker = (state, ui, romSync) =>
  bindRomDropAndPicker(state, ui, romSync, unpackRomIfNeeded);
