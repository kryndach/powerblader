// 2-PC Network, Protocol & Data Transfer Diagnostic Test Suite
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { crc32Hex } from '../src/crc32.mjs';
import { createCoopServer } from '../server/relay_server.mjs';

function httpPostJson(urlStr, payloadObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(payloadObj);
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(JSON.parse(data)));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: body }));
    }).on('error', reject);
  });
}

function bindPeer2Responder(ws2, rxChunks, onArena) {
  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'peer_ping') {
      ws2.send(JSON.stringify({ type: 'peer_pong', via: msg.via, t: msg.t }));
    } else if (msg.type === 'diag_xfer_single') {
      const u8 = new Uint8Array(Buffer.from(msg.dataB64, 'base64'));
      const crc = crc32Hex(u8);
      ws2.send(JSON.stringify({
        type: 'diag_xfer_ack', xferId: msg.xferId,
        rxBytes: u8.length, rxCrc32: crc, crcMatch: crc === msg.crc32
      }));
    } else if (msg.type === 'diag_xfer_start') {
      rxChunks.set(msg.xferId, {
        totalChunks: msg.totalChunks, totalBytes: msg.totalBytes,
        expectedCrc: msg.crc32, parts: new Map()
      });
    } else if (msg.type === 'diag_xfer_chunk') {
      const st = rxChunks.get(msg.xferId);
      if (st) {
        st.parts.set(
          msg.index, new Uint8Array(Buffer.from(msg.dataB64, 'base64'))
        );
      }
    } else if (msg.type === 'diag_xfer_end') {
      const st = rxChunks.get(msg.xferId);
      if (!st) return;
      const full = new Uint8Array(st.totalBytes);
      let offset = 0;
      for (let i = 0; i < st.totalChunks; i++) {
        const p = st.parts.get(i);
        full.set(p, offset);
        offset += p.length;
      }
      const crc = crc32Hex(full);
      ws2.send(JSON.stringify({
        type: 'diag_xfer_ack', xferId: msg.xferId,
        rxBytes: offset, rxCrc32: crc, crcMatch: crc === st.expectedCrc
      }));
    } else if (msg.type === 'diag_stream_start') {
      rxChunks.set(msg.streamId, { total: msg.totalFrames, count: 0 });
    } else if (msg.type === 'diag_stream_pkt') {
      const st = rxChunks.get(msg.streamId);
      if (st) st.count++;
    } else if (msg.type === 'diag_stream_finish') {
      const st = rxChunks.get(msg.streamId);
      ws2.send(JSON.stringify({
        type: 'diag_stream_summary',
        summary: {
          streamId: msg.streamId, via: 'wss', total: st.total,
          received: st.count, lossPct: 0, outOfOrder: 0, duplicates: 0,
          gaps: { avg: 16.6, p95: 18.0, max: 20.0, clumpedPct: 0 }
        }
      }));
    } else if (msg.type === 'diag_arena_state') {
      onArena(msg.x === 145 && msg.y === 92 && msg.btn === 3);
    }
  });
}

async function runNetDiagnosticsTests() {
  console.log(
    '=== 2-PC Network, Protocol & Data Transfer Diagnostic Test Suite ===\n'
  );

  const tmpLogsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_diag_logs_'));
  const app = createCoopServer({ logAccess: false, logsDir: tmpLogsDir });
  const port = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const res = await httpGetText(`${baseUrl}/nettest`);
  assert.strictEqual(res.status, 200, '/nettest should return HTTP 200');
  assert.ok(
    res.text.includes('2-PC Connection, Protocol & Data Transfer Debugger')
  );
  console.log('[PASS] Stage 1: Standalone /nettest Workbench Page Served');

  const ws1 = new WebSocket(wsUrl), ws2 = new WebSocket(wsUrl);
  let serverPongReceived = false, peerPongReceived = false;
  let singleXferAck = null, chunkedXferAck = null, streamSummary = null;
  let arenaStateReceived = false;
  const rxChunks = new Map();
  bindPeer2Responder(ws2, rxChunks, (ok) => { arenaStateReceived = ok; });

  await new Promise((resolve, reject) => {
    ws1.on('open', () => ws1.send(
      JSON.stringify({ type: 'join_room', roomCode: 'DIAG', nick: 'PC1-SG' })
    ));
    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'room_joined') {
        const j = JSON.stringify({
          type: 'join_room', roomCode: 'DIAG', nick: 'PC2-RU'
        });
        if (ws2.readyState === 1) ws2.send(j);
        else ws2.once('open', () => ws2.send(j));
      } else if (msg.type === 'peer_joined') {
        ws1.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        ws1.send(JSON.stringify({
          type: 'peer_ping', via: 'wss', t: performance.now()
        }));
      } else if (msg.type === 'pong') serverPongReceived = true;
      else if (msg.type === 'peer_pong') { peerPongReceived = true; resolve(); }
    });
    ws1.on('error', reject);
    ws2.on('error', reject);
  });

  assert.ok(serverPongReceived && peerPongReceived);
  console.log('[PASS] Stage 2: Server Ping & 2-PC Peer Ping Verified');

  await new Promise((resolve) => {
    const singleBytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < singleBytes.length; i++) singleBytes[i] = i & 255;
    const singleCrc = crc32Hex(singleBytes);
    const chunkedBytes = new Uint8Array(256 * 1024);
    for (let i = 0; i < chunkedBytes.length; i++) {
      chunkedBytes[i] = (i * 73 + 19) & 0xff;
    }
    const chunkedCrc = crc32Hex(chunkedBytes);

    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'diag_xfer_ack') {
        if (msg.xferId === 'single_64') singleXferAck = msg;
        if (msg.xferId === 'chunked_256') chunkedXferAck = msg;
        if (singleXferAck && chunkedXferAck) resolve();
      }
    });

    ws1.send(JSON.stringify({
      type: 'diag_xfer_single', xferId: 'single_64', kb: 64, via: 'wss',
      crc32: singleCrc, dataB64: Buffer.from(singleBytes).toString('base64')
    }));

    const chunkSize = 16 * 1024;
    const totalChunks = 16;
    ws1.send(JSON.stringify({
      type: 'diag_xfer_start', xferId: 'chunked_256', kb: 256, via: 'wss',
      totalChunks, totalBytes: chunkedBytes.length, crc32: chunkedCrc
    }));
    for (let c = 0; c < totalChunks; c++) {
      const slice = chunkedBytes.subarray(c * chunkSize, (c + 1) * chunkSize);
      ws1.send(JSON.stringify({
        type: 'diag_xfer_chunk', xferId: 'chunked_256', index: c,
        dataB64: Buffer.from(slice).toString('base64')
      }));
    }
    ws1.send(
      JSON.stringify({ type: 'diag_xfer_end', xferId: 'chunked_256' })
    );
  });

  assert.ok(singleXferAck?.crcMatch && singleXferAck.rxBytes === 65536);
  assert.ok(chunkedXferAck?.crcMatch && chunkedXferAck.rxBytes === 262144);
  console.log(
    '[PASS] Stage 3: Single-Frame (64KB) & Chunked (256KB in 16x16KB) ' +
      'Transfers + CRC32 Verified'
  );

  await new Promise((resolve) => {
    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'diag_stream_summary') {
        streamSummary = msg.summary;
        resolve();
      }
    });
    ws1.send(JSON.stringify({
      type: 'diag_arena_state', x: 145, y: 92, btn: 3, seq: 1
    }));
    ws1.send(JSON.stringify({
      type: 'diag_stream_start', streamId: 'st_60', via: 'wss', totalFrames: 60
    }));
    for (let i = 0; i < 60; i++) {
      ws1.send(JSON.stringify({
        type: 'diag_stream_pkt', streamId: 'st_60', seq: i, t: i * 16.6
      }));
    }
    ws1.send(JSON.stringify({
      type: 'diag_stream_finish', streamId: 'st_60', totalFrames: 60
    }));
  });

  assert.strictEqual(streamSummary?.received, 60);
  assert.ok(arenaStateReceived);
  console.log(
    '[PASS] Stage 4: 60Hz Packet Stream & Live 2-PC Cursor/Input Sandbox ' +
      'Verified'
  );

  ws1.close();
  ws2.close();

  const wsHost = new WebSocket(wsUrl);
  let hostSawHttpPeer = false;
  let hostGotHttpPong = false;

  await new Promise((resolve, reject) => {
    wsHost.on('open', () => {
      wsHost.send(JSON.stringify({
        type: 'join_room', roomCode: 'HTTPFALLBACK',
        clientId: 'host_ws', nick: 'Host-SG'
      }));
    });
    wsHost.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'room_joined') {
          const joinRes = await httpPostJson(`${baseUrl}/api/http-tunnel`, {
            roomCode: 'HTTPFALLBACK', clientId: 'bro_http_only',
            nick: 'Brother-RU', join: true, ackSeq: 0, messages: []
          });
          assert.ok(joinRes.ok && joinRes.playerIndex === 2);
        } else if (msg.type === 'peer_joined') {
          hostSawHttpPeer =
            msg.peer?.clientId === 'bro_http_only' &&
            msg.peer?.httpActive === true;
          wsHost.send(
            JSON.stringify({ type: 'peer_ping', via: 'http', t: 12345 })
          );
          await new Promise((r) => setTimeout(r, 30));
          const poll1 = await httpPostJson(`${baseUrl}/api/http-tunnel`, {
            roomCode: 'HTTPFALLBACK', clientId: 'bro_http_only',
            nick: 'Brother-RU', ackSeq: 0, messages: []
          });
          const pingMsg = poll1.messages.find((m) => m.type === 'peer_ping');
          assert.ok(pingMsg);
          await httpPostJson(`${baseUrl}/api/http-tunnel`, {
            roomCode: 'HTTPFALLBACK', clientId: 'bro_http_only',
            nick: 'Brother-RU', ackSeq: pingMsg._seq,
            messages: [{ type: 'peer_pong', via: 'http', t: pingMsg.t }]
          });
        } else if (msg.type === 'peer_pong' && msg.via === 'http') {
          hostGotHttpPong = true;
          resolve();
        }
      } catch (err) {
        reject(err);
      }
    });
    wsHost.on('error', reject);
  });

  assert.ok(hostSawHttpPeer && hostGotHttpPong);
  console.log(
    '[PASS] Stage 5: Pure HTTPS Tunnel Fallback (/api/http-tunnel) Verified'
  );

  const autoHtml = await httpGetText(`${baseUrl}/autotest`);
  assert.ok(autoHtml.status === 200);
  assert.ok(autoHtml.text.includes('AUTOBENCH v3.0'));

  const repRes = await httpPostJson(`${baseUrl}/api/autotest-report`, {
    playerIndex: 1, overallStatus: 'COMPLETE', serverRttMs: 1, wssRttMs: 250,
    dualWsOk: true,
    httpBench: {
      payloadKb: 512, singleDlKbps: 280, stripeDlKbps: 1420, speedup: 5.1,
      pc2UploadKbps: 980, firstDlPct: 3, firstUlPct: 3, crcOk: true
    },
    wasmBench: {
      hashMatch: true,
      pc1: { bootMs: 42, visMs: 0.9, rb5Ms: 4.8, hash60: 'A1B2C3D4' },
      pc2: { bootMs: 85, visMs: 1.4, rb5Ms: 7.5, hash60: 'A1B2C3D4' }
    },
    liveNetplay: {
      frames: 110, pc1Hash: 'DEAD1234', pc2Hash: 'DEAD1234', hashMatch: true,
      pc1Desyncs: 0, pc2Desyncs: 0, pc1Rollbacks: 8, pc2Rollbacks: 9,
      syncImportOk: true
    },
    recommendations: {
      transport: 'Dual-WSS Relay (ws + wsAux)',
      nesDelayFrames: 4, arcadeDelayFrames: 4, cpu60FpsOk: true
    },
    stages: [
      { name: '1. Baseline WSS Relay Ping', status: 'PASS', summary: '1' }
    ],
    webrtcProfiles: [{
      id: 'ru_sip', name: 'RU SIP STUN', open: false, iceState: 'failed',
      localTypes: ['host', 'srflx'], remoteTypes: ['host']
    }],
    logs: ['[Test] Auto-benchmark completed'], isFinal: true
  });
  assert.ok(repRes.ok);
  assert.ok(repRes.combinedText.includes('2-PC AUTOMATED NETWORK'));
  assert.ok(repRes.combinedText.includes('AUTO-TUNED NETPLAY RECOMMENDATIONS'));
  assert.ok(fs.existsSync(path.join(tmpLogsDir, 'autotest_latest.json')));
  fs.rmSync(tmpLogsDir, { recursive: true, force: true });
  console.log(
    '[PASS] Stage 6: Zero-Click /autotest v3.0 & Isolated Disk Save Verified'
  );

  wsHost.close();
  await app.close();
  console.log('\nALL 2-PC NETWORK & PROTOCOL DIAGNOSTIC TESTS PASSED!');
}

runNetDiagnosticsTests().catch((err) => {
  console.error('Network Diagnostic Test Failed:', err);
  process.exit(1);
});
