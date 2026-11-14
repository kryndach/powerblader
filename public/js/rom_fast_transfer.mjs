// Parallel Striped HTTP Range Downloader, Multipart Uploader & IDB ROM Cache
const IDB_NAME = 'nes_online_rom_cache_v1';
const IDB_STORE = 'roms';
const memCacheFallback = new Map();

export function isLocalHostRuntime() {
  const h = globalThis.location?.hostname || '';
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
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
    onProgress?.(100);
    return { romName, romCrc32, u8: out };
  }

  const cr = pRes.headers.get('Content-Range') || '';
  const m = /\/(\d+)$/.exec(cr);
  const total = m ? Number(m[1]) : firstBuf.length;
  if (firstBuf.length >= total) {
    const out = payloadEnc === 'gzip' ? await gunzipBytes(firstBuf) : firstBuf;
    onProgress?.(100);
    return { romName, romCrc32, u8: out };
  }

  const full = new Uint8Array(total);
  full.set(firstBuf, 0);
  let loaded = firstBuf.length;
  let lastPct = Math.min(99, Math.round((loaded / total) * 100));
  if (lastPct > 0) onProgress?.(lastPct);

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
        const r = await fetchWithRetry(url, {
          headers: { ...baseHdrs, Range: `bytes=${start}-${end}` }, signal
        }, 3, doFetch);
        if (!r.ok && r.status !== 206) {
          throw new Error(`Slice HTTP ${r.status}`);
        }
        const chunk = new Uint8Array(await r.arrayBuffer());
        full.set(chunk, start);
        loaded += chunk.length;
        const pct = Math.min(99, Math.round((loaded / total) * 100));
        if (pct >= lastPct + 2) {
          lastPct = pct;
          onProgress?.(pct);
        }
      }
    }
  );
  await Promise.all(workers);
  const out = payloadEnc === 'gzip' ? await gunzipBytes(full) : full;
  onProgress?.(100);
  return { romName, romCrc32, u8: out };
}

export async function uploadStripedRom(
  baseUrl, body, headers = {}, {
    concurrency = 8, sliceBytes = 262144, onProgress = null, fetchImpl = null,
    forceStriped = false
  } = {}
) {
  const doFetch = fetchImpl || globalThis.fetch;
  const useSingle =
    !forceStriped && (body.byteLength <= sliceBytes || isLocalHostRuntime());
  if (useSingle) {
    const r = await fetchWithRetry(
      baseUrl, { method: 'POST', headers, body }, 3, doFetch
    );
    if (r.ok) onProgress?.(100);
    return r.ok;
  }
  const totalBytes = body.byteLength;
  const totalParts = Math.ceil(totalBytes / sliceBytes);
  let sentBytes = 0, lastPct = 0, cursor = 0;

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
        sentBytes += slice.length;
        const pct = Math.min(99, Math.round((sentBytes / totalBytes) * 100));
        if (pct >= lastPct + 3) {
          lastPct = pct;
          onProgress?.(pct);
        }
      }
    }
  );
  await Promise.all(workers);
  onProgress?.(100);
  return true;
}

export async function uploadRomToServerCache(state, onProgress = null) {
  const base = state.apiBaseUrl || '';
  if ((typeof window === 'undefined' && !base) || typeof fetch !== 'function' ||
      !state.romUint8 || !state.romCrc32) return null;
  const rm = state.roomCode || 'NOVA', crc = state.romCrc32;
  if (state.roomRomUploadedCrc === crc) return rm;
  if (state.roomRomUploadPromise && state.roomRomUploadingCrc === crc) {
    return state.roomRomUploadPromise;
  }
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
      const ok = await uploadStripedRom(
        `${base}/api/room-rom?${q}`, body, headers, { onProgress }
      );
      if (ok) { state.roomRomUploadedCrc = crc; return rm; }
    } catch {} finally {
      state.roomRomUploadPromise = null;
    }
    return null;
  })();
  return state.roomRomUploadPromise;
}

export async function fetchRomBytesWithProgress(
  url, label, fileName, ui, onProgress = null, signal = null
) {
  ui.showScreenBanner(`${label} "${fileName}" (0%)...`, 'warn', 8000);
  const dl = await fetchStripedBinary(url, {
    signal,
    onProgress: (pct) => {
      onProgress?.(pct);
      if (pct < 100) {
        const msg = `${label} "${fileName}" (${pct}%)...`;
        ui.showScreenBanner(msg, 'warn', 8000);
      }
    }
  });
  if (!dl) return null;
  return { romName: dl.romName || fileName, romCrc32: dl.romCrc32, u8: dl.u8 };
}
