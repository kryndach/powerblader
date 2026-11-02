import assert from 'assert';
import http from 'http';
import WebSocket from 'ws';
import { createCoopServer } from '../server/relay_server.mjs';

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: body }));
      })
      .on('error', reject);
  });
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32Bytes(u8) {
  let crc = 0xffffffff;
  for (let i = 0; i < u8.length; i++) {
    crc = CRC_TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

async function runNetDiagnosticsTests() {
  console.log('=== 2-PC Network, Protocol & Data Transfer Diagnostic Test Suite ===\n');

  const app = createCoopServer();
  const port = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  // 1. Verify /nettest serves the standalone 2-PC Diagnostic Workbench HTML
  const res = await httpGetText(`${baseUrl}/nettest`);
  assert.strictEqual(res.status, 200, '/nettest should return HTTP 200');
  const html = res.text;
  assert.ok(html.includes('2-PC Connection, Protocol & Data Transfer Debugger'), 'Missing NetBench title');
  console.log('[PASS] Stage 1: Standalone /nettest Workbench Page Served');

  // 2. Connect PC 1 and PC 2 and test Server Ping + End-to-End Peer Ping
  const ws1 = new WebSocket(wsUrl);
  const ws2 = new WebSocket(wsUrl);

  let serverPongReceived = false;
  let peerPongReceived = false;
  let singleXferAck = null;
  let chunkedXferAck = null;
  let streamSummary = null;
  let arenaStateReceived = false;

  const rxChunks = new Map();

  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'peer_ping') {
      ws2.send(JSON.stringify({ type: 'peer_pong', via: msg.via, t: msg.t }));
    } else if (msg.type === 'diag_xfer_single') {
      const u8 = new Uint8Array(Buffer.from(msg.dataB64, 'base64'));
      const crc = crc32Bytes(u8);
      ws2.send(
        JSON.stringify({
          type: 'diag_xfer_ack',
          xferId: msg.xferId,
          rxBytes: u8.length,
          rxCrc32: crc,
          crcMatch: crc === msg.crc32
        })
      );
    } else if (msg.type === 'diag_xfer_start') {
      rxChunks.set(msg.xferId, {
        totalChunks: msg.totalChunks,
        totalBytes: msg.totalBytes,
        expectedCrc: msg.crc32,
        parts: new Map()
      });
    } else if (msg.type === 'diag_xfer_chunk') {
      const st = rxChunks.get(msg.xferId);
      if (st) st.parts.set(msg.index, new Uint8Array(Buffer.from(msg.dataB64, 'base64')));
    } else if (msg.type === 'diag_xfer_end') {
      const st = rxChunks.get(msg.xferId);
      if (st) {
        const full = new Uint8Array(st.totalBytes);
        let offset = 0;
        for (let i = 0; i < st.totalChunks; i++) {
          const p = st.parts.get(i);
          full.set(p, offset);
          offset += p.length;
        }
        const crc = crc32Bytes(full);
        ws2.send(
          JSON.stringify({
            type: 'diag_xfer_ack',
            xferId: msg.xferId,
            rxBytes: offset,
            rxCrc32: crc,
            crcMatch: crc === st.expectedCrc
          })
        );
      }
    } else if (msg.type === 'diag_stream_start') {
      rxChunks.set(msg.streamId, { total: msg.totalFrames, count: 0 });
    } else if (msg.type === 'diag_stream_pkt') {
      const st = rxChunks.get(msg.streamId);
      if (st) st.count++;
    } else if (msg.type === 'diag_stream_finish') {
      const st = rxChunks.get(msg.streamId);
      ws2.send(
        JSON.stringify({
          type: 'diag_stream_summary',
          summary: {
            streamId: msg.streamId,
            via: 'wss',
            total: st.total,
            received: st.count,
            lossPct: 0,
            outOfOrder: 0,
            duplicates: 0,
            gaps: { avg: 16.6, p95: 18.0, max: 20.0, clumpedPct: 0 }
          }
        })
      );
    } else if (msg.type === 'diag_arena_state') {
      arenaStateReceived = msg.x === 145 && msg.y === 92 && msg.btn === 3;
    }
  });

  await new Promise((resolve, reject) => {
    ws1.on('open', () => {
      ws1.send(JSON.stringify({ type: 'join_room', roomCode: 'DIAG', nick: 'PC1-SG' }));
    });
    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'room_joined') {
        ws2.send(JSON.stringify({ type: 'join_room', roomCode: 'DIAG', nick: 'PC2-RU' }));
      } else if (msg.type === 'peer_joined') {
        // Trigger Server Ping + Peer Ping
        ws1.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        ws1.send(JSON.stringify({ type: 'peer_ping', via: 'wss', t: performance.now() }));
      } else if (msg.type === 'pong') {
        serverPongReceived = true;
      } else if (msg.type === 'peer_pong') {
        peerPongReceived = true;
        resolve();
      }
    });
    ws1.on('error', reject);
    ws2.on('error', reject);
  });

  assert.ok(serverPongReceived && peerPongReceived, 'Server or Peer ping/pong failed');
  console.log('[PASS] Stage 2: Server Ping & End-to-End 2-PC Peer Ping Verified');

  // 3. Test 64KB Single-Frame & 256KB Chunked (16x16KB) Transfers with CRC32
  await new Promise((resolve) => {
    const singleBytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < singleBytes.length; i++) singleBytes[i] = (i * 31) & 0xff;
    const singleCrc = crc32Bytes(singleBytes);

    const chunkedBytes = new Uint8Array(256 * 1024);
    for (let i = 0; i < chunkedBytes.length; i++) chunkedBytes[i] = (i * 73 + 19) & 0xff;
    const chunkedCrc = crc32Bytes(chunkedBytes);

    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'diag_xfer_ack') {
        if (msg.xferId === 'single_64') singleXferAck = msg;
        if (msg.xferId === 'chunked_256') chunkedXferAck = msg;
        if (singleXferAck && chunkedXferAck) resolve();
      }
    });

    ws1.send(
      JSON.stringify({
        type: 'diag_xfer_single',
        xferId: 'single_64',
        kb: 64,
        via: 'wss',
        crc32: singleCrc,
        dataB64: Buffer.from(singleBytes).toString('base64')
      })
    );

    const chunkSize = 16 * 1024;
    const totalChunks = 16;
    ws1.send(
      JSON.stringify({
        type: 'diag_xfer_start',
        xferId: 'chunked_256',
        kb: 256,
        via: 'wss',
        totalChunks,
        totalBytes: chunkedBytes.length,
        crc32: chunkedCrc
      })
    );
    for (let c = 0; c < totalChunks; c++) {
      const slice = chunkedBytes.subarray(c * chunkSize, (c + 1) * chunkSize);
      ws1.send(
        JSON.stringify({
          type: 'diag_xfer_chunk',
          xferId: 'chunked_256',
          index: c,
          dataB64: Buffer.from(slice).toString('base64')
        })
      );
    }
    ws1.send(JSON.stringify({ type: 'diag_xfer_end', xferId: 'chunked_256' }));
  });

  assert.ok(singleXferAck?.crcMatch, '64KB single-frame CRC mismatch');
  assert.strictEqual(singleXferAck.rxBytes, 65536);
  assert.ok(chunkedXferAck?.crcMatch, '256KB chunked transfer CRC mismatch');
  assert.strictEqual(chunkedXferAck.rxBytes, 262144);
  console.log('[PASS] Stage 3: Single-Frame (64KB) & Chunked (256KB in 16x16KB) Transfers + CRC32 Verified');

  // 4. Test 60Hz Packet Stream & Live 2-PC Arena State
  await new Promise((resolve) => {
    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'diag_stream_summary') {
        streamSummary = msg.summary;
        resolve();
      }
    });

    ws1.send(JSON.stringify({ type: 'diag_arena_state', x: 145, y: 92, btn: 3, seq: 1 }));
    ws1.send(JSON.stringify({ type: 'diag_stream_start', streamId: 'st_60', via: 'wss', totalFrames: 60 }));
    for (let i = 0; i < 60; i++) {
      ws1.send(JSON.stringify({ type: 'diag_stream_pkt', streamId: 'st_60', seq: i, t: i * 16.6 }));
    }
    ws1.send(JSON.stringify({ type: 'diag_stream_finish', streamId: 'st_60', totalFrames: 60 }));
  });

  assert.strictEqual(streamSummary?.received, 60, 'Expected 60/60 stream packets received');
  assert.ok(arenaStateReceived, 'Expected live 2-PC arena state packet to reach PC 2');
  console.log('[PASS] Stage 4: 60Hz Packet Stream & Live 2-PC Cursor/Input Sandbox Verified');

  ws1.close();
  ws2.close();
  await app.close();

  console.log('\nALL 2-PC NETWORK & PROTOCOL DIAGNOSTIC TESTS PASSED!');
}

runNetDiagnosticsTests().catch((err) => {
  console.error('Network Diagnostic Test Failed:', err);
  process.exit(1);
});
