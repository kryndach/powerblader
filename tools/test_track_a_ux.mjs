// TDD Verification Suite for Track A5 (UX/Transfer/Auth) & A6 (Benchmarks)
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCoopServer } from '../server/relay_server.mjs';
import {
  streamRomToPeer, handleRomTransferMessage
} from '../public/js/rom_archive.mjs';
import { uploadRomToServerCache } from '../public/js/rom_fast_transfer.mjs';
import { updateTransferUi } from '../public/js/transfer_status_ui.mjs';
import {
  decodeBinaryRomChunk, isBinaryRomChunk
} from '../src/binary_net_codec.mjs';
import { startNetemProxy } from './netem_proxy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function httpReq(port, urlPath, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method, headers
    }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, body: Buffer.concat(ch).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function testA5aProgressNotClampedAt100AndBinaryP2pRom() {
  const sent = [];
  const xferLog = [];
  const state = {
    ws: {
      isServerlessP2p: true, readyState: 1, bufferedAmount: 0,
      send: (d) => sent.push(d)
    },
    romName: 'tgm2p.zip', romCrc32: '2AAB0722', isAutoDefaultRom: false,
    romUint8: new Uint8Array(40000).map((_, i) => (i * 13) & 0xff),
    transferStatus: null
  };
  const ui = {
    setTransferStatus: (x) => {
      updateTransferUi(state, ui, x);
      xferLog.push({ ...state.transferStatus });
    },
    showScreenBanner: () => {}, updateStatusStrip: () => {},
    resetSendRomButtons: () => {}
  };
  await streamRomToPeer(state, ui, 'sid_p2p', { frame: 0 }, () => '');

  const binChunks = sent.filter((m) => isBinaryRomChunk(m));
  assert.ok(binChunks.length >= 2, 'P2P ROM transfer must use binary chunks');
  const lastPhase = xferLog[xferLog.length - 1];
  assert.strictEqual(lastPhase.phase, 'partner-core');
  assert.strictEqual(
    lastPhase.pct, 0,
    `partner-core must start at 0% (not 100%) so WASM progress advances!`
  );

  // Subsequent 15% WASM download progress from partner MUST show 15%, not 100%
  handleRomTransferMessage({
    type: 'rom_transfer_progress', sessionId: 'sid_p2p',
    stage: 'loading-core', pct: 15, loadedBytes: 1500, totalBytes: 10000
  }, state, ui, {}, () => {}, () => {}, () => new Uint8Array(0));
  assert.strictEqual(state.transferStatus.pct, 15);

  // Decode binary ROM chunk round-trip
  const firstDec = decodeBinaryRomChunk(binChunks[0]);
  assert.strictEqual(firstDec.index, 0);
  assert.ok(firstDec.data.byteLength > 0);
  console.log('[PASS] A5a: Unclamped WASM Progress & Binary P2P ROM Chunks');
}

async function testA5bAuthOnGuestUploadSaveSlotAndHttpTunnel() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_a5_auth_'));
  const app = createCoopServer({
    logAccess: false, logsDir: tmp, savesDir: path.join(tmp, 'saves')
  });
  await app.beacon.setRoomPassword('NOVA', 'secret99');
  const authToken = app.beacon.getRoomAuthStatus().authToken;
  const port = await app.listen(0, '127.0.0.1');
  try {
    // Unauthenticated remote Host must get 403 on save-slot & http-tunnel
    const remHdr = { Host: 'guest.run.pinggy-free.link' };
    const rSave = await httpReq(
      port, '/api/save-slot?crc=ABCD1234', 'GET', null, remHdr
    );
    assert.strictEqual(rSave.status, 403, '/api/save-slot bypassed roomAuth!');
    const rTun = await httpReq(
      port, '/api/http-tunnel', 'POST', JSON.stringify({ roomCode: 'NOVA' }),
      { ...remHdr, 'Content-Type': 'application/json' }
    );
    assert.strictEqual(rTun.status, 403, '/api/http-tunnel bypassed roomAuth!');

    // Guest uploadRomToServerCache MUST include state.roomAuth
    let sawAuth = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = new URL(String(url));
      if (u.searchParams.get('auth') === authToken ||
          opts.headers?.['X-Room-Auth'] === authToken) {
        sawAuth = true;
      }
      const r = await httpReq(
        port, `${u.pathname}${u.search}`, opts.method || 'GET', opts.body,
        { ...(opts.headers || {}), Host: 'guest.run.pinggy-free.link' }
      );
      return { ok: r.status >= 200 && r.status < 300, status: r.status };
    };
    try {
      const st = {
        apiBaseUrl: `http://127.0.0.1:${port}`, roomCode: 'AUTH1',
        roomAuth: authToken, romName: 'test.nes', romCrc32: '1234ABCD',
        romUint8: new Uint8Array(64).fill(7)
      };
      const rm = await uploadRomToServerCache(st);
      assert.strictEqual(rm, 'AUTH1');
      assert.ok(sawAuth, 'uploadRomToServerCache omitted state.roomAuth!');
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('[PASS] A5b: Room Auth on Guest Upload, Save-Slot & HTTP-Tunnel');
}

function testA5cStaticSafetyAndFootguns() {
  const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const kb = rd('public/js/key_bindings.mjs');
  assert.ok(!kb.includes('>F5<'), 'key_bindings.mjs still hints F5!');
  assert.ok(kb.includes('>F6<'), 'key_bindings.mjs must hint F6');

  const df = rd('Dockerfile');
  assert.ok(!df.includes('COPY games'), 'Dockerfile has broken COPY games');

  const uiJs = rd('public/js/console_ui.mjs');
  assert.ok(uiJs.includes('&lt;'), 'console_ui.mjs missing HTML escaping');

  const at = rd('public/js/autotest_stages.mjs');
  assert.ok(!at.includes('batchSize = 3'), '/autotest still batches 20Hz');
  console.log('[PASS] A5c/A6: F6 Hint, Dockerfile, HTML Escaping & 60Hz');
}

async function testA6SharedPipeNetem() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_a6_netem_'));
  const app = createCoopServer({ logAccess: false, logsDir: tmp });
  const port = await app.listen(0, '127.0.0.1');
  const proxy = await startNetemProxy(port, { sharedPipe: true, rttMs: 20 });
  try {
    assert.strictEqual(proxy.getStats().sharedPipe, true);
  } finally {
    await proxy.close();
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('[PASS] A6: Shared-SSH-Pipe Netem Mode Verified');
}

async function main() {
  console.log('=== Track A5-A6 UX, Auth & Benchmark TDD Suite ===\n');
  await testA5aProgressNotClampedAt100AndBinaryP2pRom();
  await testA5bAuthOnGuestUploadSaveSlotAndHttpTunnel();
  testA5cStaticSafetyAndFootguns();
  await testA6SharedPipeNetem();
  console.log('\nALL TRACK A5-A6 TESTS PASSED!');
}

main().catch((err) => {
  console.error('\n[FAIL] Track A5-A6 TDD Suite:', err);
  process.exit(1);
});
