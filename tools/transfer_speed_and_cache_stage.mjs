// Bandwidth-Throttled Pinggy Per-Stream Benchmark, Zero-Upload & Cache QA Gate
import assert from 'assert';
import http from 'http';
import { computeRomCrc32 } from '../src/crc32.mjs';
import { createMinimalArcadeTestZip } from '../src/fbneo_arcade_core.mjs';
import { createCoopServer } from '../server/relay_server.mjs';
import {
  isLocalHostRuntime, fetchStripedBinary, uploadStripedRom,
  putCachedRomByCrc, clearMemRomCacheForTests
} from '../public/js/rom_fast_transfer.mjs';
import {
  unpackRomIfNeeded, handleRomTransferMessage
} from '../public/js/rom_archive.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMockResponse(status, rawHdrs, buf) {
  const lower = {};
  for (const [k, v] of Object.entries(rawHdrs || {})) {
    lower[k.toLowerCase()] = String(v);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => lower[String(k).toLowerCase()] ?? null },
    body: {
      getReader() {
        let off = 0;
        return {
          async read() {
            if (off >= buf.byteLength) return { done: true, value: undefined };
            const end = Math.min(buf.byteLength, off + 16384);
            const slice = new Uint8Array(
              buf.buffer, buf.byteOffset + off, end - off
            );
            off = end;
            return { done: false, value: slice };
          }
        };
      }
    },
    arrayBuffer: async () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  };
}

function nodeHttpFetch(urlStr, init = {}) {
  return new Promise((resolve, reject) => {
    if (init.signal?.aborted) {
      const err = new Error('Aborted'); err.name = 'AbortError';
      return reject(err);
    }
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: init.method || 'GET', headers: init.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(
        makeMockResponse(res.statusCode, res.headers, Buffer.concat(chunks))
      ));
    });
    req.on('error', reject);
    if (init.signal?.addEventListener) {
      init.signal.addEventListener('abort', () => {
        req.destroy();
        const err = new Error('Aborted'); err.name = 'AbortError';
        reject(err);
      }, { once: true });
    }
    if (init.body) req.write(Buffer.from(init.body));
    req.end();
  });
}

function makePseudoRandomArcadeZip(sizeBytes = 1572864) {
  const minZip = createMinimalArcadeTestZip();
  const out = new Uint8Array(sizeBytes);
  out.set(minZip, 0);
  let x = 0x9e3779b9;
  for (let i = minZip.length; i < sizeBytes; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function createPinggyWindowThrottledFetch(per128KbMs = 28, inject502 = false) {
  let getDropsLeft = inject502 ? 1 : 0;
  let postDropsLeft = inject502 ? 1 : 0;
  let totalCalls = 0;
  const wrapped = async (url, init = {}) => {
    totalCalls++;
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'POST' && String(url).includes('part=2') &&
        postDropsLeft > 0) {
      postDropsLeft--;
      return makeMockResponse(502, {}, Buffer.from('Tunnel glitch'));
    }
    const rng = String(init.headers?.Range || '');
    if (method === 'GET' && rng.includes('-') && !rng.startsWith('bytes=0-') &&
        getDropsLeft > 0) {
      getDropsLeft--;
      return makeMockResponse(502, {}, Buffer.from('Tunnel glitch'));
    }
    const reqBytes = init.body?.byteLength || 0;
    if (reqBytes > 0) {
      await sleep(Math.max(1, Math.ceil(reqBytes / 131072)) * per128KbMs);
    }
    const res = await nodeHttpFetch(url, init);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 0) {
      await sleep(Math.max(1, Math.ceil(ab.byteLength / 131072)) * per128KbMs);
    }
    return res;
  };
  return {
    wrapped, getStats: () => ({ totalCalls, getDropsLeft, postDropsLeft })
  };
}

export async function runTest10PinggyTransferAndZeroUploadGate() {
  const app = createCoopServer({ logAccess: false });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const origLoc = globalThis.location, origFetch = globalThis.fetch;

  try {
    globalThis.fetch = nodeHttpFetch;
    const payload = makePseudoRandomArcadeZip(2097152);
    const expectedCrc = computeRomCrc32(payload);
    const { wrapped } = createPinggyWindowThrottledFetch(25, false);
    const glitch = createPinggyWindowThrottledFetch(10, true);
    const hdrs = { 'Content-Type': 'application/octet-stream' };

    const tUpSingle0 = performance.now();
    const singleUpRes = await wrapped(
      `${base}/api/room-rom?room=SLOW&crc=${expectedCrc}&name=tgm2p.zip`,
      { method: 'POST', headers: hdrs, body: payload }
    );
    assert.strictEqual(singleUpRes.ok, true);
    const singleUpMs = performance.now() - tUpSingle0;

    const upMarks = [];
    const tUpStripe0 = performance.now();
    const upOpts = {
      concurrency: 8, sliceBytes: 262144, fetchImpl: wrapped,
      forceStriped: true, onProgress: (p, info) => upMarks.push({ p, info })
    };
    const okStripeUp = await uploadStripedRom(
      `${base}/api/room-rom?room=FAST&crc=${expectedCrc}&name=tgm2p.zip`,
      payload, hdrs, upOpts
    );
    const stripeUpMs = performance.now() - tUpStripe0;
    assert.strictEqual(okStripeUp, true);
    assert.strictEqual(upMarks[0]?.p, 0, 'Upload must emit 0% immediately');
    assert.ok(
      upMarks.some((m) => m.p > 0 && m.p <= 13 && m.info?.bps > 0),
      'Upload must emit live byte/speed progress on the very first slice'
    );

    const tDlSingle0 = performance.now();
    const singleDlRes = await wrapped(
      `${base}/api/room-rom?room=FAST&crc=${expectedCrc}`
    );
    const singleDlBytes = new Uint8Array(await singleDlRes.arrayBuffer());
    const singleDlMs = performance.now() - tDlSingle0;
    assert.strictEqual(computeRomCrc32(singleDlBytes), expectedCrc);

    const progressMarks = [];
    const tDlStripe0 = performance.now();
    const stripeDl = await fetchStripedBinary(
      `${base}/api/room-rom?room=FAST&crc=${expectedCrc}`,
      {
        concurrency: 8, probeBytes: 16384, sliceBytes: 262144,
        fetchImpl: wrapped,
        onProgress: (p, info) => progressMarks.push({ p, info })
      }
    );
    const stripeDlMs = performance.now() - tDlStripe0;
    assert.ok(stripeDl?.u8, 'Striped download must succeed');
    assert.strictEqual(computeRomCrc32(stripeDl.u8), expectedCrc);
    assert.strictEqual(
      progressMarks[0]?.p, 1,
      'First 16KB chunk of 2MB download must emit 1% (never freeze until 4%!)'
    );
    assert.strictEqual(progressMarks[0]?.info?.totalBytes, payload.byteLength);
    assert.strictEqual(progressMarks[progressMarks.length - 1]?.p, 100);

    const ok502Up = await uploadStripedRom(
      `${base}/api/room-rom?room=DROP&crc=${expectedCrc}&name=tgm2p.zip`,
      payload, hdrs, {
        concurrency: 8, sliceBytes: 262144,
        fetchImpl: glitch.wrapped, forceStriped: true
      }
    );
    const dl502 = await fetchStripedBinary(
      `${base}/api/room-rom?room=DROP&crc=${expectedCrc}`,
      { concurrency: 8, sliceBytes: 262144, fetchImpl: glitch.wrapped }
    );
    assert.strictEqual(ok502Up, true);
    assert.strictEqual(computeRomCrc32(dl502.u8), expectedCrc);
    assert.strictEqual(glitch.getStats().postDropsLeft, 0);
    assert.strictEqual(glitch.getStats().getDropsLeft, 0);

    const upSpeedup = singleUpMs / Math.max(1, stripeUpMs);
    const dlSpeedup = singleDlMs / Math.max(1, stripeDlMs);
    assert.ok(
      upSpeedup >= 3.2 && dlSpeedup >= 3.2,
      `Expected >=3.2x striped speedup (got up=${upSpeedup.toFixed(1)}x, ` +
        `dl=${dlSpeedup.toFixed(1)}x)`
    );

    // 2. FBNeo 23.85 MB WASM Striped Gzip-Range Transfer (<6.5 MB wire, \0asm)
    const wasmDl = await fetchStripedBinary(
      `${base}/vendor/fbneo_arcade.wasm?v=2`,
      { concurrency: 8, probeBytes: 262144, sliceBytes: 1048576 }
    );
    assert.ok(wasmDl?.u8?.byteLength > 20 * 1024 * 1024, 'Full FBNeo WASM');
    assert.strictEqual(wasmDl.u8[0], 0x00);
    assert.strictEqual(wasmDl.u8[1], 0x61);
    assert.strictEqual(wasmDl.u8[2], 0x73);
    assert.strictEqual(wasmDl.u8[3], 0x6d);

    // 3. Zero-Upload Guard on Remote Pinggy Client Loading Local Archive
    globalThis.location = { hostname: 'yjego-119-56.a.free.pinggy.link' };
    assert.strictEqual(isLocalHostRuntime(), false);
    let remoteFetchCount = 0;
    globalThis.fetch = async (...args) => {
      remoteFetchCount++;
      return nodeHttpFetch(...args);
    };
    const unpacked = await unpackRomIfNeeded(payload, 'tgm2p.zip', 'NOVA');
    assert.strictEqual(unpacked.romName, 'tgm2p.zip');
    assert.strictEqual(
      remoteFetchCount, 0,
      'Remote Pinggy client MUST NOT upload local .zip to /api/extract-rom!'
    );

    // 4. Persistent CRC32 Cache Hit (0 HTTP requests) & Duplicate Send Guard
    clearMemRomCacheForTests();
    await putCachedRomByCrc(expectedCrc, 'tgm2p.zip', payload);
    let syncedSession = null;
    const mockState = { apiBaseUrl: base, engine: { syncPaused: false } };
    const mockUi = { showScreenBanner: () => {}, updateStatusStrip: () => {} };
    const mockRomSync = {
      loadRomFromUint8: async (u8) => {
        mockState.romCrc32 = computeRomCrc32(u8);
      }
    };
    handleRomTransferMessage(
      {
        type: 'rom_chunk_start', sessionId: 'S_CACHED',
        roomRomKey: 'FAST', romName: 'tgm2p.zip', romCrc32: expectedCrc,
        syncState: { sessionId: 'S_CACHED', frame: 0 }
      },
      mockState, mockUi, mockRomSync,
      (st) => { syncedSession = st.sessionId; }, () => {}, () => null
    );
    await sleep(30);
    assert.strictEqual(syncedSession, 'S_CACHED');
    assert.strictEqual(
      remoteFetchCount, 0,
      'Cached CRC32 ROM must load in 0 network requests!'
    );

    clearMemRomCacheForTests();
    globalThis.fetch = wrapped;
    handleRomTransferMessage(
      {
        type: 'rom_chunk_start', sessionId: 'S1',
        roomRomKey: 'FAST', romName: 'tgm2p.zip', romCrc32: expectedCrc,
        syncState: { sessionId: 'S1', frame: 0 }
      },
      mockState, mockUi, mockRomSync,
      (st) => { syncedSession = st.sessionId; }, () => {}, () => null
    );
    const firstCtrl = mockState.activeRomAbortCtrl;
    await sleep(15);
    handleRomTransferMessage(
      {
        type: 'rom_chunk_start', sessionId: 'S2',
        roomRomKey: 'FAST', romName: 'tgm2p.zip', romCrc32: expectedCrc,
        syncState: { sessionId: 'S2', frame: 0 }
      },
      mockState, mockUi, mockRomSync,
      (st) => { syncedSession = st.sessionId; }, () => {}, () => null
    );
    if (firstCtrl) {
      assert.strictEqual(
        firstCtrl.signal.aborted, false,
        'Duplicate Send ROM for same CRC32 must NOT abort in-flight download!'
      );
    }
    while (mockState.activeRomDownload) await sleep(15);
    assert.strictEqual(syncedSession, 'S2');

    const upStr = upSpeedup.toFixed(1), dlStr = dlSpeedup.toFixed(1);
    console.log(
      `[PASS] Edge Case 9: Pinggy Per-Stream Window Benchmark ` +
        `(8x Striped Up=${upStr}x / Dl=${dlStr}x + 502 Retry + ` +
        `Zero-Upload Remote Load + 0-Byte CRC Cache)`
    );
  } finally {
    globalThis.location = origLoc;
    globalThis.fetch = origFetch;
    clearMemRomCacheForTests();
    await app.close();
  }
}
