// TDD Regression Suite: Audit Priority 1 (Binary Codec, Multipart, HTTP Tunnel)
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import WebSocket from 'ws';
import * as jsnesMod from 'jsnes';
import {
  BIN_MAGIC_INPUT, encodeNetplayPacketBinary, decodeNetplayPacketBinary,
  extractBinaryInputDedupKey, encodeBinaryRomChunk, hashSessionId32
} from '../src/binary_net_codec.mjs';
import { relayBinaryFrame } from '../server/wire_rtt_prober.mjs';
import { NesNetplayEngine } from '../src/netplay_engine.mjs';
import { createCoopServer } from '../server/relay_server.mjs';
import { uploadStripedRom } from '../public/js/rom_fast_transfer.mjs';
import { createDualControllerTestRom } from './test_rom_builder_tables.mjs';

const jsnes = jsnesMod.NES ? jsnesMod : jsnesMod.default;

function httpReq(port, urlPath, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method, headers
    }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(ch)
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function testP1_1TruncatedBinaryInputNoCrash() {
  // Truncated 16B wide 0x4e frame with pairCnt=1 used to throw RangeError
  const t16 = new Uint8Array(16);
  t16[0] = BIN_MAGIC_INPUT; t16[1] = 0x02; t16[15] = 1;
  assert.strictEqual(extractBinaryInputDedupKey(t16), null);

  const t17 = new Uint8Array(17);
  t17[0] = BIN_MAGIC_INPUT; t17[1] = 0x02; t17[15] = 1;
  assert.strictEqual(extractBinaryInputDedupKey(t17), null);

  const tNarrow = new Uint8Array(18);
  tNarrow[0] = BIN_MAGIC_INPUT; tNarrow[1] = 0x00; tNarrow[15] = 2;
  assert.strictEqual(extractBinaryInputDedupKey(tNarrow), null);

  const tHash = new Uint8Array(18);
  tHash[0] = BIN_MAGIC_INPUT; tHash[1] = 0x01; tHash[15] = 1;
  assert.strictEqual(extractBinaryInputDedupKey(tHash), null);
  console.log('[PASS] P1-1a: extractBinaryInputDedupKey guards truncated');
}

function testP1_3BinaryTailCountAndSignedAck() {
  // 1. tailCount is TOTAL length (including inputs.length), NOT extra count
  const dec1 = decodeNetplayPacketBinary(encodeNetplayPacketBinary({
    type: 'netplay_input', sessionId: 's_tail', startFrame: 50,
    inputs: [5, 0], tailCount: 10, ack: 45
  }), 's_tail');
  assert.strictEqual(dec1.inputs.length, 10);
  assert.deepStrictEqual(dec1.inputs, [5, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  const dec2 = decodeNetplayPacketBinary(encodeNetplayPacketBinary({
    type: 'netplay_input', sessionId: 's_tail', startFrame: 40,
    inputs: [0], tailCount: 32, ack: 30
  }), 's_tail');
  assert.strictEqual(dec2.inputs.length, 32);

  // 2. Signed Int16 ackDelta supports ack > startFrame AND ack == -1
  const decAhead = decodeNetplayPacketBinary(encodeNetplayPacketBinary({
    type: 'netplay_input', sessionId: 's_ack', startFrame: 100,
    inputs: [1], ack: 108
  }), 's_ack');
  assert.strictEqual(decAhead.ack, 108);

  const dec0 = decodeNetplayPacketBinary(encodeNetplayPacketBinary({
    type: 'netplay_input', sessionId: 's_ack', startFrame: 0,
    inputs: [0], ack: 4
  }), 's_ack');
  assert.strictEqual(dec0.ack, 4);

  const decNeg1 = decodeNetplayPacketBinary(encodeNetplayPacketBinary({
    type: 'netplay_input', sessionId: 's_ack', startFrame: 0,
    inputs: [0], ack: -1
  }), 's_ack');
  assert.strictEqual(decNeg1.ack, -1);

  const decNoAck = decodeNetplayPacketBinary(encodeNetplayPacketBinary({
    type: 'netplay_input', sessionId: 's_ack', startFrame: 50, inputs: [0]
  }), 's_ack');
  assert.strictEqual(decNoAck.ack, undefined);

  // Out-of-Int16-range ack delta MUST omit ack (not fabricate a false ack!)
  for (const [sf, ack] of [[40000, -1], [50000, 0], [100, 40000]]) {
    const dec = decodeNetplayPacketBinary(encodeNetplayPacketBinary({
      type: 'netplay_input', sessionId: 's_ack', startFrame: sf,
      inputs: [1], ack
    }), 's_ack');
    assert.strictEqual(dec.ack, undefined, `Fabricated ack=${dec.ack}`);
  }
  console.log('[PASS] P1-3: Binary tailCount & Signed Int16 ackDelta verified');
}

async function testP1_2MultipartBoundsAndCorsHeaders() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_p1_2_'));
  const app = createCoopServer({ logAccess: false, logsDir: tmp });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const opt = await httpReq(port, '/api/room-rom', 'OPTIONS');
    assert.strictEqual(opt.status, 204);
    const methods = String(opt.headers['access-control-allow-methods'] || '');
    const expose = String(opt.headers['access-control-expose-headers'] || '');
    assert.ok(methods.includes('HEAD'), `Missing HEAD: ${methods}`);
    assert.ok(expose.includes('X-Raw-Length'), `Missing X-Raw-Length`);

    const bigRes = await httpReq(
      port,
      '/api/room-rom?room=M1&crc=AAA1&name=a.nes&part=0&total=2' +
        '&offset=0&size=200000000',
      'POST', Buffer.from([1, 2, 3, 4])
    );
    assert.strictEqual(bigRes.status, 400, 'Must reject fullSize > 64MB');

    const negRes = await httpReq(
      port,
      '/api/room-rom?room=M1&crc=AAA2&name=a.nes&part=0&total=2' +
        '&offset=-4&size=16',
      'POST', Buffer.alloc(8, 0xaa)
    );
    assert.strictEqual(negRes.status, 400, 'Must reject negative offset');

    const oobRes = await httpReq(
      port,
      '/api/room-rom?room=M1&crc=AAA3&name=a.nes&part=0&total=2' +
        '&offset=12&size=16',
      'POST', Buffer.alloc(8, 0xaa)
    );
    assert.strictEqual(oobRes.status, 400, 'Must reject offset+len > size');

    // Gapped parts (bytesWritten !== fullSize) must return 400 & not cache
    const g0 = await httpReq(
      port,
      '/api/room-rom?room=M2&crc=GAP1&name=gap.nes&part=0&total=2' +
        '&offset=0&size=32',
      'POST', Buffer.alloc(4, 0x11)
    );
    assert.strictEqual(g0.status, 200);
    const g1 = await httpReq(
      port,
      '/api/room-rom?room=M2&crc=GAP1&name=gap.nes&part=1&total=2' +
        '&offset=28&size=32',
      'POST', Buffer.alloc(4, 0x22)
    );
    assert.strictEqual(g1.status, 400, `Expected 400, got ${g1.status}`);
    const leakGet = await httpReq(port, '/api/room-rom?room=M2&crc=GAP1');
    assert.strictEqual(leakGet.status, 404, 'Incomplete ROM cached!');

    // Valid 2-part upload with idempotent retry on part 0 succeeds
    const p0 = Buffer.alloc(16, 0x33), p1 = Buffer.alloc(16, 0x44);
    const uPath0 = '/api/room-rom?room=M3&crc=OK11&name=ok.nes&part=0&total=2' +
      '&offset=0&size=32';
    const uPath1 = '/api/room-rom?room=M3&crc=OK11&name=ok.nes&part=1&total=2' +
      '&offset=16&size=32';
    assert.strictEqual((await httpReq(port, uPath0, 'POST', p0)).status, 200);
    assert.strictEqual((await httpReq(port, uPath0, 'POST', p0)).status, 200);
    assert.strictEqual((await httpReq(port, uPath1, 'POST', p1)).status, 200);
    const okGet = await httpReq(port, '/api/room-rom?room=M3&crc=OK11');
    assert.strictEqual(okGet.status, 200);
    assert.deepStrictEqual(okGet.body, Buffer.concat([p0, p1]));

    // HEAD exposes X-Raw-Length + CORS; forceStriped total=1 works
    const head = await httpReq(port, '/api/room-rom?room=M3&crc=OK11', 'HEAD');
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.headers['x-raw-length'], '32');
    assert.ok(String(head.headers['access-control-expose-headers'] || '')
      .includes('X-Raw-Length'));
    const nodeFetch = async (u, init = {}) => {
      const url = new URL(String(u));
      const r = await httpReq(
        port, `${url.pathname}${url.search}`, init.method || 'GET',
        init.body ? Buffer.from(init.body) : null, init.headers || {}
      );
      return { ok: r.status >= 200 && r.status < 300, status: r.status };
    };
    const ok1 = await uploadStripedRom(
      `http://127.0.0.1:${port}/api/room-rom?room=F1&crc=F100&name=s.nes`,
      new Uint8Array(64).fill(0x5a),
      { 'Content-Type': 'application/octet-stream' },
      { forceStriped: true, sliceBytes: 1024, fetchImpl: nodeFetch }
    );
    assert.strictEqual(ok1, true, 'forceStriped total=1 failed!');

    // Overlapping chunks with bytesWritten === fullSize + gap -> 400
    const ovB = '/api/room-rom?room=OV&crc=OV1&name=o.nes&total=2&size=32';
    assert.strictEqual((await httpReq(
      port, `${ovB}&part=0&offset=0`, 'POST', Buffer.alloc(20, 1)
    )).status, 200);
    assert.strictEqual((await httpReq(
      port, `${ovB}&part=1&offset=10`, 'POST', Buffer.alloc(12, 2)
    )).status, 400);

    // Invalid params, >8 eviction, and gzip bomb (>64 MiB) -> 400
    for (const q of [
      'part=0&total=0&offset=0&size=16',
      'part=abc&total=2&offset=0&size=16',
      'part=0&total=2&offset=0&size=NaN'
    ]) {
      assert.strictEqual((await httpReq(
        port, `/api/room-rom?room=B&crc=B&name=b.nes&${q}`, 'POST',
        Buffer.alloc(8, 3)
      )).status, 400);
    }
    for (let i = 0; i < 10; i++) {
      const u = `/api/room-rom?room=EV${i}&crc=E${i}&name=e.nes` +
        '&part=0&total=2&offset=0&size=32';
      assert.strictEqual((await httpReq(port, u, 'POST', Buffer.alloc(16, i)))
        .status, 200);
    }
    const bombGz = zlib.gzipSync(Buffer.alloc(65 * 1024 * 1024, 0));
    const bRes = await httpReq(
      port, '/api/room-rom?room=BOMB&crc=B1&name=b.nes', 'POST', bombGz,
      { 'X-Rom-Encoding': 'gzip', 'Content-Type': 'application/octet-stream' }
    );
    assert.strictEqual(bRes.status, 400, 'Gzip bomb >64MB not rejected!');
    console.log('[PASS] P1-2: Multipart Bounds, Coverage & CORS Headers');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testP1_4HttpTunnelBinaryAndWsTruncatedSurvival() {
  const { binaryString } = createDualControllerTestRom(0);
  const nes = new jsnes.NES({});
  nes.loadROM(binaryString);
  const eng = new NesNetplayEngine(nes, { localPlayer: 2, online: true });
  eng.resetTimeline(0, 'real_sess_99');
  const h = hashSessionId32('real_sess_99').toString(16);
  eng.receiveRemoteInputPacket({
    type: 'netplay_input', sessionId: `bin_${h}`, startFrame: 0, inputs: [3]
  });
  assert.strictEqual(eng.lastConfirmedRemoteFrame, 0);
  eng.receiveRemoteInputPacket({
    type: 'netplay_input', sessionId: 'bin_deadbeef', startFrame: 1, inputs: [7]
  });
  assert.strictEqual(eng.lastConfirmedRemoteFrame, 0);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_p1_4_'));
  const app = createCoopServer({ logAccess: false, logsDir: tmp });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const p1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => p1.once('open', r));
    p1.send(JSON.stringify({
      type: 'join_room', roomCode: 'HTB1', clientId: 'ws1', nick: 'Host'
    }));
    await new Promise((r) => p1.once('message', r));

    const hdr = { 'Content-Type': 'application/json' };
    const jBody = JSON.stringify({
      roomCode: 'HTB1', clientId: 'http2', nick: 'GuestHttp', join: true
    });
    const jRes = await httpReq(port, '/api/http-tunnel', 'POST', jBody, hdr);
    assert.strictEqual(jRes.status, 200);

    // Send truncated 16B wide 0x4e frame -> server must NOT crash
    const bad = new Uint8Array(16);
    bad[0] = BIN_MAGIC_INPUT; bad[1] = 0x02; bad[15] = 1;
    p1.send(bad);

    p1.send(JSON.stringify({
      type: 'match_start_req', sessionId: 'sess_http_1', romCrc32: 'AABBCCDD'
    }));
    p1.send(encodeNetplayPacketBinary({
      type: 'netplay_input', sessionId: 'sess_http_1', startFrame: 2,
      inputs: [9, 9], ack: 1
    }));
    p1.send(encodeNetplayPacketBinary({ type: 'peer_ping', t: 1234567 }));
    p1.send(encodeNetplayPacketBinary({ type: 'peer_pong', t: 7654321 }));
    p1.send(encodeBinaryRomChunk(
      'rom_s1', 0, new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    ));
    await new Promise((r) => setTimeout(r, 80));

    const pollRes = await httpReq(
      port, '/api/http-tunnel', 'POST', JSON.stringify({
        roomCode: 'HTB1', clientId: 'http2', nick: 'GuestHttp',
        ackSeq: 0, messages: []
      }), hdr
    );
    assert.strictEqual(pollRes.status, 200);
    const msgs = JSON.parse(pollRes.body.toString('utf8')).messages || [];
    const inp = msgs.find((m) => m.type === 'netplay_input');
    const ping = msgs.find((m) => m.type === 'peer_ping');
    const pong = msgs.find((m) => m.type === 'peer_pong');
    const chunk = msgs.find((m) => m.type === 'rom_chunk_data');
    const expB64 = Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64');

    assert.ok(inp && inp.sessionId === 'sess_http_1');
    assert.ok(ping && ping.t === 1234567, 'Dropped binary peer_ping');
    assert.ok(pong && pong.t === 7654321, 'Dropped binary peer_pong');
    assert.ok(chunk && chunk.dataB64 === expB64, 'Dropped binary rom_chunk');
    p1.close();

    // Plain Uint8Array (non-Buffer) ROM chunk + unjoined binary WS frame
    const dstU8 = { clientId: 'h2', ws: null, httpOutbox: [], nextSeq: 1 };
    const srcU8 = { clientId: 'w1', roomCode: 'U8R' };
    const rm = new Map([['U8R', new Map([['w1', srcU8], ['h2', dstU8]])]]);
    relayBinaryFrame(
      rm, srcU8, encodeBinaryRomChunk('rs', 3, new Uint8Array([9, 8])), () => 0
    );
    assert.strictEqual(dstU8.httpOutbox.length, 1);
    const unj = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => unj.once('open', r));
    unj.send(Buffer.from(JSON.stringify({
      type: 'join_room', roomCode: 'BINJ', nick: 'Bad'
    })));
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(app.rooms.has('BINJ'), false);
    unj.close();
    console.log('[PASS] P1-1b & P1-4: Truncated WS Survival & HTTP Binary');
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  console.log('=== Audit Priority 1 TDD Regression Suite ===\n');
  testP1_1TruncatedBinaryInputNoCrash();
  testP1_3BinaryTailCountAndSignedAck();
  await testP1_2MultipartBoundsAndCorsHeaders();
  await testP1_4HttpTunnelBinaryAndWsTruncatedSurvival();
  console.log('\nALL AUDIT PRIORITY 1 TESTS PASSED!');
}

main().catch((err) => {
  console.error('\n[FAIL] Audit P1 Suite:', err);
  process.exit(1);
});
