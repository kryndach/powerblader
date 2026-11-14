// Parallel Striped HTTP Range Downloader, Multipart Uploader & IDB ROM Cache
import { formatTransferProgress } from './transfer_status_ui.mjs';
export { formatTransferProgress };

const IDB_NAME = 'nes_online_rom_cache_v1';
const IDB_STORE = 'roms';
const memCacheFallback = new Map();

export function isLocalHostRuntime() {
  const h = globalThis.location?.hostname || '';
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function createByteTracker(totalBytes, onProgress) {
  const t0 = performance.now();
  let loaded = 0, lastEmit = 0, lastPct = -1;
  const emit = (force = false) => {
    if (!onProgress) return;
    const now = performance.now();
    const pct = totalBytes > 0
      ? (loaded >= totalBytes ? 100
        : loaded > 0 ? Math.max(1, Math.min(99, Math.round(
          (loaded / totalBytes) * 100
        ))) : 0)
      : 0;
    const firstReal = lastPct <= 0 && pct > 0;
    if (!force && !firstReal) {
      if (lastPct >= 0 && pct === lastPct && now - lastEmit < 180) return;
      if (lastPct >= 0 && now - lastEmit < 90 && pct < 100) return;
    }
    lastPct = pct;
    lastEmit = now;
    const dtSec = Math.max(0.05, (now - t0) / 1000);
    const bps = loaded > 0 ? Math.round(loaded / dtSec) : 0;
    onProgress(pct, { pct, loadedBytes: loaded, totalBytes, bps });
  };
  return {
    emitZero: () => emit(true),
    add: (n) => { loaded += n; emit(false); },
    rollback: (n) => { loaded = Math.max(0, loaded - n); },
    done: (finalTotal = totalBytes) => {
      loaded = finalTotal;
      emit(true);
    }
  };
}

function openRomIdb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function getCachedRomByCrc(crc) {
  const key = String(crc || '').trim().toUpperCase();
  if (!key) return null;
  if (memCacheFallback.has(key)) return memCacheFallback.get(key);
  const db = await openRomIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const val = req.result;
        if (val?.u8) {
          resolve({ romName: val.romName, u8: new Uint8Array(val.u8) });
        } else resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function putCachedRomByCrc(crc, romName, u8) {
  const key = String(crc || '').trim().toUpperCase();
  if (!key || !u8?.byteLength) return;
  if (typeof indexedDB === 'undefined') {
    memCacheFallback.set(key, { romName, u8: new Uint8Array(u8) });
    return;
  }
  const db = await openRomIdb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ romName, u8, ts: Date.now() }, key);
  } catch {}
}

export function clearMemRomCacheForTests() {
  memCacheFallback.clear();
}

async function gunzipBytes(u8) {
  if (typeof DecompressionStream === 'function') {
    const s = new Blob([u8]).stream().pipeThrough(
      new DecompressionStream('gzip')
    );
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  const zlib = await import('node:zlib');
  return new Uint8Array(zlib.gunzipSync(u8));
}

async function fetchWithRetry(url, init, retries = 3, doFetch = null) {
  const fn = doFetch || globalThis.fetch;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (init?.signal?.aborted) {
        throw init.signal.reason || new Error('Aborted');
      }
      const res = await fn(url, init);
      if (res.ok || res.status === 206 || res.status === 404) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (e?.name === 'AbortError' || init?.signal?.aborted) throw e;
      lastErr = e;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('Fetch failed');
}

async function fetchSliceInto(url, init, dst, start, maxLen, tracker, doFetch) {
  let lastErr = null;
  for (let attempt = 0; attempt <= 3; attempt++) {
    let added = 0;
    try {
      const r = await fetchWithRetry(url, init, 0, doFetch);
      if (!r.ok && r.status !== 206) throw new Error(`Slice HTTP ${r.status}`);
      if (r.body?.getReader) {
        const reader = r.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const n = Math.min(value.byteLength, maxLen - added);
          if (n > 0) {
            dst.set(value.subarray(0, n), start + added);
            added += n;
            tracker.add(n);
          }
        }
        return added;
      }
      const chunk = new Uint8Array(await r.arrayBuffer());
      const n = Math.min(chunk.byteLength, maxLen);
      dst.set(chunk.subarray(0, n), start);
      added = n;
      tracker.add(n);
      return added;
    } catch (e) {
      if (added > 0) tracker.rollback(added);
      if (e?.name === 'AbortError' || init?.signal?.aborted) throw e;
      lastErr = e;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
      }
    }
  }
  throw lastErr || new Error('Slice download failed');
}

export async function fetchStripedBinary(url, {
  concurrency = 8,
  probeBytes = 65536,
  sliceBytes = 262144,
  onProgress = null,
  signal = null,
  fetchImpl = null
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const canGunzip = typeof DecompressionStream === 'function' ||
    Boolean(globalThis.process?.versions?.node);
  const baseHdrs = canGunzip ? { 'X-Accept-Raw-Gz': '1' } : {};

  const pRes = await fetchWithRetry(url, {
    headers: { ...baseHdrs, Range: `bytes=0-${probeBytes - 1}` }, signal
  }, 3, doFetch);
  if (pRes.status === 404 || (!pRes.ok && pRes.status !== 206)) return null;

  const hdrName = pRes.headers.get('X-Rom-Filename');
  const romName = hdrName ? decodeURIComponent(hdrName) : null;
  const romCrc32 = pRes.headers.get('X-Rom-Crc32') || null;
  const payloadEnc = pRes.headers.get('X-Payload-Encoding') || 'identity';
  const firstBuf = new Uint8Array(await pRes.arrayBuffer());

  if (pRes.status !== 206) {
    const out = payloadEnc === 'gzip' ? await gunzipBytes(firstBuf) : firstBuf;
    onProgress?.(100, {
      pct: 100, loadedBytes: out.byteLength, totalBytes: out.byteLength, bps: 0
    });
    return { romName, romCrc32, u8: out };
  }

  const cr = pRes.headers.get('Content-Range') || '';
  const m = /\/(\d+)$/.exec(cr);
  const total = m ? Number(m[1]) : firstBuf.length;
  const tracker = createByteTracker(total, onProgress);
  if (firstBuf.length >= total) {
    const out = payloadEnc === 'gzip' ? await gunzipBytes(firstBuf) : firstBuf;
    tracker.done(total);
    return { romName, romCrc32, u8: out };
  }

  const full = new Uint8Array(total);
  full.set(firstBuf, 0);
  tracker.add(firstBuf.length);

  const ranges = [];
  for (let pos = firstBuf.length; pos < total; pos += sliceBytes) {
    ranges.push([pos, Math.min(total - 1, pos + sliceBytes - 1)]);
  }

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, ranges.length) },
    async () => {
      while (cursor < ranges.length) {
        const [start, end] = ranges[cursor++];
        const init = {
          headers: { ...baseHdrs, Range: `bytes=${start}-${end}` }, signal
        };
        await fetchSliceInto(
          url, init, full, start, end - start + 1, tracker, doFetch
        );
      }
    }
  );
  await Promise.all(workers);
  const out = payloadEnc === 'gzip' ? await gunzipBytes(full) : full;
  tracker.done(total);
  return { romName, romCrc32, u8: out };
}

export async function uploadStripedRom(
  baseUrl, body, headers = {}, {
    concurrency = 8, sliceBytes = 262144, onProgress = null, fetchImpl = null,
    forceStriped = false
  } = {}
) {
  const doFetch = fetchImpl || globalThis.fetch;
  const totalBytes = body.byteLength;
  const tracker = createByteTracker(totalBytes, onProgress);
  tracker.emitZero();
  const useSingle =
    !forceStriped && (totalBytes <= sliceBytes || isLocalHostRuntime());
  if (useSingle) {
    const r = await fetchWithRetry(
      baseUrl, { method: 'POST', headers, body }, 3, doFetch
    );
    if (r.ok) tracker.done(totalBytes);
    return r.ok;
  }
  const totalParts = Math.ceil(totalBytes / sliceBytes);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, totalParts) },
    async () => {
      while (cursor < totalParts) {
        const part = cursor++;
        const off = part * sliceBytes;
        const endOff = Math.min(totalBytes, off + sliceBytes);
        const slice = body.subarray(off, endOff);
        const sep = baseUrl.includes('?') ? '&' : '?';
        const u = `${baseUrl}${sep}part=${part}&total=${totalParts}` +
          `&offset=${off}&size=${totalBytes}`;
        const r = await fetchWithRetry(u, {
          method: 'POST', headers, body: slice
        }, 3, doFetch);
        if (!r.ok) throw new Error(`Upload part ${part} HTTP ${r.status}`);
        tracker.add(slice.length);
      }
    }
  );
  await Promise.all(workers);
  tracker.done(totalBytes);
  return true;
}

export async function uploadRomToServerCache(state, onProgress = null) {
  const base = state.apiBaseUrl || '';
  if ((typeof window === 'undefined' && !base) || typeof fetch !== 'function' ||
      !state.romUint8 || !state.romCrc32) return null;
  const rm = state.roomCode || 'NOVA', crc = state.romCrc32;
  state.roomRomOnProgress = onProgress;
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
        const gz = new CompressionStream('gzip');
        const s = new Blob([body]).stream().pipeThrough(gz);
        body = new Uint8Array(await new Response(s).arrayBuffer());
        headers['X-Rom-Encoding'] = 'gzip';
      }
      const q = `room=${encodeURIComponent(rm)}&crc=${encodeURIComponent(crc)}`
        + `&name=${encodeURIComponent(state.romName)}`;
      const ok = await uploadStripedRom(
        `${base}/api/room-rom?${q}`, body, headers,
        { onProgress: (p, info) => state.roomRomOnProgress?.(p, info) }
      );
      if (ok) { state.roomRomUploadedCrc = crc; return rm; }
    } catch {} finally {
      state.roomRomUploadPromise = null; state.roomRomOnProgress = null;
    }
    return null;
  })();
  return state.roomRomUploadPromise;
}

export async function fetchRomBytesWithProgress(
  url, label, fileName, ui, onProgress = null, signal = null
) {
  const phase = label === 'DOWNLOADING' ? 'downloading' : 'local-load';
  const show = (pct, detail) => ui.setTransferStatus
    ? ui.setTransferStatus({ phase, romName: fileName, pct, detail })
    : ui.showScreenBanner(`${label} "${fileName}" - ${detail}`, 'warn', 0);
  show(0, '0%');
  const dl = await fetchStripedBinary(url, {
    signal,
    onProgress: (pct, info) => {
      onProgress?.(pct, info);
      if (pct < 100) show(pct, formatTransferProgress(info || { pct }));
    }
  });
  if (!dl) { ui.setTransferStatus?.(null); return null; }
  return { romName: dl.romName || fileName, romCrc32: dl.romCrc32, u8: dl.u8 };
}
