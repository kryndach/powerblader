// TDD Verification Suite for Track A1-A6 Upgrades (No Goodhart Thresholds)
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import * as jsnesModule from 'jsnes';
import {
  NesNetplayEngine, computeRecommendedInputDelay
} from '../src/netplay_engine.mjs';
import { createDualControllerTestRom } from './test_rom_builder_tables.mjs';
import { createProtocolHandlers } from '../public/js/net_protocol_handlers.mjs';
import { createNetTransport } from '../public/js/webrtc_p2p.mjs';
import { createRomSyncManager } from '../public/js/rom_sync.mjs';
import { createTelemetryReporter } from '../public/js/telemetry_reporter.mjs';
import { createCoopServer } from '../server/relay_server.mjs';
import { stepPacingAccumulator } from '../public/js/frame_loop.mjs';
import {
  encodeNetplayPacketBinary, decodeNetplayPacketBinary, isBinaryNetplayPacket
} from '../src/binary_net_codec.mjs';

const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;

function testA1PacingClumpSignAndLazyBuffers() {
  const { binaryString } = createDualControllerTestRom(0);
  const nes = new jsnes.NES({});
  nes.loadROM(binaryString);
  const eng = new NesNetplayEngine(nes, {
    localPlayer: 1, online: true, inputDelayFrames: 0,
    enableVisualSmoothing: false
  });
  assert.strictEqual(
    eng._preRollbackBuffer, null,
    'Dead visual smoothing buffers should not allocate when disabled'
  );
  // Asymmetric clumping: Peer A sees rxClump=4, peerClump=0 -> myLead inflated
  eng.currentFrame = 20;
  eng.lastConfirmedRemoteFrame = 10;
  eng.rxClumpFrames = 4;
  eng.riftFrames = 0;
  eng.receiveRemoteInputPacket({
    type: 'netplay_input', sessionId: eng.sessionId, startFrame: 10,
    inputs: [0], peerLead: 6, rxClump: 0, inputDelay: 0
  }, 1000);
  // rawRift = (10 - 6) * 0.5 = +2.0; subtracting clumpBias MUST reduce rift!
  assert.ok(
    eng.clumpBiasFrames > 0 && eng.riftFrames < 0.6,
    `Expected clumpBias to subtract from rawRift, got rift=${eng.riftFrames} ` +
      `clumpBias=${eng.clumpBiasFrames}`
  );

  // 60.00 Hz display pacing: 0 double-steps at rift=0, fractional pace at 0.8
  assert.strictEqual(typeof stepPacingAccumulator, 'function');
  let acc = 0, ticks = 0, doubles = 0;
  for (let i = 0; i < 1800; i++) {
    const r = stepPacingAccumulator(acc, 1000 / 60, 0, true);
    acc = r.accumulatorMs;
    let n = 0;
    while (acc >= r.effectiveFrameMs) { acc -= r.effectiveFrameMs; n++; }
    ticks += n;
    if (n > 1) doubles++;
  }
  assert.strictEqual(doubles, 0, `60Hz steady had ${doubles} double-steps`);
  assert.strictEqual(ticks, 1800);

  const paced = stepPacingAccumulator(0, 1000 / 60, 0.8, true);
  assert.ok(
    paced.accumulatorMs < paced.effectiveFrameMs,
    'rift=0.8 must NOT snap accumulatorMs = effectiveFrameMs on 60Hz'
  );
  console.log('[PASS] A1: 60Hz Pacing, clumpBias Sign & Lazy Buffers');
}

async function testA2HonestP2pPingSmartAutoAndIce() {
  const wsOut = [], rtcOut = [];
  const state = {
    ws: { readyState: 1, send: (d) => wsOut.push(d) },
    rtcChannel: { readyState: 'open', send: (d) => rtcOut.push(d) },
    wsAux: null, peerConnected: true, localPlayerIndex: 1,
    rttMs: 180, wssRttMs: 180, p2pRttMs: 260, jitterMs: 5,
    simLossPct: 0, simLagMs: 0, txCountThisSec: 0, rxCountThisSec: 0,
    telemetrySamples: [], telemetryEvents: []
  };
  const ui = {
    transportModeSelect: { value: 'auto' },
    inputDelaySelect: { value: '2', querySelector: () => null },
    dbgRtcState: { textContent: '' }, dbgWssState: { textContent: '' },
    pingBadge: { textContent: '' }, dbgRtt: { textContent: '' },
    updateStatusStrip: () => {}, logDebug: () => {}, showScreenBanner: () => {}
  };
  const tel = createTelemetryReporter(state, ui, {});
  const proto = createProtocolHandlers(
    state, ui, { routeNetplayInput: () => true }, {}, tel,
    { sendFastNetplayPacket: () => {}, handleWebRtcSignal: () => {} }
  );
  proto.handleIncomingNetMessage({ type: 'peer_ping', t: 12345 }, 'p2p');
  assert.strictEqual(rtcOut.length, 1, 'P2P peer_ping must reply on P2P');
  assert.strictEqual(wsOut.length, 0, 'P2P peer_ping must NOT reply on WSS');

  const tr = createNetTransport(state, ui, () => {});
  const pkt = {
    type: 'netplay_input', sessionId: 's1', startFrame: 10, inputs: [1]
  };
  wsOut.length = 0; rtcOut.length = 0;
  tr.sendFastNetplayPacket(pkt);
  assert.strictEqual(
    wsOut.length, 1, 'Auto mode must pick WSS when P2P RTT (260) > WSS (180)'
  );
  assert.strictEqual(rtcOut.length, 0);

  state.p2pRttMs = 140;
  wsOut.length = 0; rtcOut.length = 0;
  tr.sendFastNetplayPacket(pkt);
  assert.strictEqual(
    rtcOut.length, 1, 'Auto mode must pick P2P when P2P RTT (140) < WSS (180)'
  );

  // Answerer trickle ICE + early candidate queuing
  const addedIce = [];
  let remoteSet = false;
  const origRtc = globalThis.RTCPeerConnection;
  const origDesc = globalThis.RTCSessionDescription;
  const origCand = globalThis.RTCIceCandidate;
  let lastRtc = null;
  globalThis.RTCSessionDescription = class {
    constructor(x) { Object.assign(this, x); }
  };
  globalThis.RTCIceCandidate = class {
    constructor(x) { Object.assign(this, x); }
  };
  globalThis.RTCPeerConnection = class {
    constructor() {
      this.iceGatheringState = 'complete';
      this.connectionState = 'new';
      lastRtc = this;
    }
    async setRemoteDescription(d) {
      this.remoteDescription = d; remoteSet = true;
    }
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async addIceCandidate(c) {
      if (!remoteSet) throw new Error('Remote description not set');
      addedIce.push(c);
    }
    close() {}
  };
  try {
    wsOut.length = 0;
    const tr2 = createNetTransport({ ...state, rtcPeer: null }, ui, () => {});
    await tr2.handleWebRtcSignal({ candidate: { candidate: 'cand_early' } });
    assert.strictEqual(addedIce.length, 0, 'Early ICE must queue until SDP');
    await tr2.handleWebRtcSignal({ sdp: { type: 'offer', sdp: 'v=0' } });
    assert.strictEqual(addedIce.length, 1, 'Queued early ICE not flushed');
    lastRtc.onicecandidate({ candidate: { candidate: 'cand_late_answerer' } });
    const sentLate = wsOut.some((s) =>
      String(s).includes('cand_late_answerer')
    );
    assert.ok(sentLate, 'Answerer dropped late trickle ICE candidate');
  } finally {
    globalThis.RTCPeerConnection = origRtc;
    globalThis.RTCSessionDescription = origDesc;
    globalThis.RTCIceCandidate = origCand;
  }
  console.log('[PASS] A2: Honest P2P Ping, Smart Auto & Answerer ICE');
}

async function testA3BinaryCodecAndAsyncServerGzip() {
  const pkt = {
    type: 'netplay_input', sessionId: 'sess_42', startFrame: 1200,
    inputs: [5, 5, 5, 5], ack: 1192, peerLead: 7, rxClump: 1.5, inputDelay: 2
  };
  const bin = encodeNetplayPacketBinary(pkt);
  assert.ok(isBinaryNetplayPacket(bin));
  assert.ok(bin.byteLength <= 20, `Binary pkt too big: ${bin.byteLength}B`);
  const dec = decodeNetplayPacketBinary(bin, 'sess_42');
  assert.strictEqual(dec.type, 'netplay_input');
  assert.strictEqual(dec.sessionId, 'sess_42');
  assert.strictEqual(dec.startFrame, 1200);
  assert.deepStrictEqual(dec.inputs, [5, 5, 5, 5]);
  assert.strictEqual(dec.ack, 1192);
  assert.strictEqual(dec.peerLead, 7);
  assert.strictEqual(dec.inputDelay, 2);

  // Verify relay_server forwards binary packets & serves WASM gzip async!
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_a3_'));
  const app = createCoopServer({ logAccess: false, logsDir: tmp });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const p1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const p2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await Promise.all([
      new Promise((r) => p1.once('open', r)),
      new Promise((r) => p2.once('open', r))
    ]);
    p1.send(JSON.stringify({ type: 'join_room', roomCode: 'BIN', nick: 'P1' }));
    p2.send(JSON.stringify({ type: 'join_room', roomCode: 'BIN', nick: 'P2' }));
    await new Promise((r) => setTimeout(r, 60));
    const gotBin = new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('Binary relay timeout')), 2000
      );
      p2.on('message', (data, isBin) => {
        if (isBin && isBinaryNetplayPacket(data)) {
          clearTimeout(t);
          resolve(decodeNetplayPacketBinary(data, 'sess_42'));
        }
      });
    });
    p1.send(bin);
    p1.send(bin); // Duplicate must be deduped
    const relayed = await gotBin;
    assert.strictEqual(relayed.startFrame, 1200);
    p1.close(); p2.close();

    // Event-loop stall check on cold FBNeo WASM gzip (must NOT freeze >150ms!)
    let maxLag = 0, lastT = performance.now();
    const hb = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - lastT - 10);
      lastT = now;
    }, 10);
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/vendor/fbneo_arcade.wasm',
        headers: { 'Accept-Encoding': 'gzip' }
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
    clearInterval(hb);
    assert.ok(
      maxLag < 150,
      `Relay server event loop froze ${Math.round(maxLag)}ms on WASM gzip!`
    );
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('[PASS] A3: 18B Binary Protocol, Relay Fast-Path & Async Gzip');
}

function testA4AutoDelayFloorsAndNoArcadeHijack() {
  assert.strictEqual(computeRecommendedInputDelay(15, 2, 0, null), 0);
  assert.strictEqual(computeRecommendedInputDelay(55, 4, 0, null), 1);
  assert.strictEqual(computeRecommendedInputDelay(120, 5, 0, null), 2);
  assert.strictEqual(computeRecommendedInputDelay(230, 10, 1, null), 3);

  const state = {
    peerConnected: true, rttMs: 240, jitterMs: 10,
    engine: {
      core: { systemId: 'arcade' }, rxClumpFrames: 1,
      shadowRollback: { isReady: () => true }
    }
  };
  const ui = {
    topInputDelaySelect: { value: '2' }, inputDelaySelect: { value: '2' }
  };
  const rs = createRomSyncManager(state, ui, {});
  assert.strictEqual(
    rs.resolveDesiredInputDelay('arcade'), 2,
    'Explicit user 2f selection on Arcade was silently hijacked!'
  );
  ui.topInputDelaySelect.value = ui.inputDelaySelect.value = 'auto';
  assert.ok(
    rs.resolveDesiredInputDelay('arcade') <= 2,
    'Shadow-Worker Arcade Auto delay should stay <= 2f'
  );
  console.log('[PASS] A4: Auto-Delay Floors & Arcade 2f Respect');
}

async function main() {
  console.log('=== Track A Upgrades TDD Suite ===\n');
  testA1PacingClumpSignAndLazyBuffers();
  await testA2HonestP2pPingSmartAutoAndIce();
  await testA3BinaryCodecAndAsyncServerGzip();
  testA4AutoDelayFloorsAndNoArcadeHijack();
  console.log('\nALL TRACK A1-A4 TESTS PASSED!');
}

main().catch((err) => {
  console.error('\n[FAIL] Track A TDD Suite:', err);
  process.exit(1);
});
