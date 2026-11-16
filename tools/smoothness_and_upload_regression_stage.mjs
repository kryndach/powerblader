// Regression Tests: Dual-WS Skew Dedup, 0f High-RTT Smoothness & 502 Upload
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import * as jsnesModule from 'jsnes';
import { NesNetplayEngine, INPUT_BITS } from '../src/netplay_engine.mjs';
import { createCoopServer } from '../server/relay_server.mjs';
import { createProtocolHandlers } from '../public/js/net_protocol_handlers.mjs';
import { createTelemetryReporter } from '../public/js/telemetry_reporter.mjs';
import { uploadStripedRom } from '../public/js/rom_fast_transfer.mjs';

const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function testSkewedDualWsDeduplication() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_dedup_'));
  const app = createCoopServer({ logAccess: false, logsDir: tmp });
  const port = await app.listen(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const openWs = (u) => new Promise((res, rej) => {
    const w = new WebSocket(u);
    w.once('open', () => res(w));
    w.once('error', rej);
  });

  let ws1, ws1Aux, ws2, ws2Aux;
  try {
    ws1 = await openWs(wsUrl);
    ws2 = await openWs(wsUrl);
    const j1 = new Promise((r) => ws1.once('message', (d) => r(JSON.parse(d))));
    ws1.send(JSON.stringify({
      type: 'join_room', roomCode: 'DEDUP', clientId: 'c1', nick: 'P1'
    }));
    await j1;
    const j2 = new Promise((r) => ws2.once('message', (d) => r(JSON.parse(d))));
    ws2.send(JSON.stringify({
      type: 'join_room', roomCode: 'DEDUP', clientId: 'c2', nick: 'P2'
    }));
    await j2;

    ws1Aux = await openWs(`${wsUrl}?aux=1`);
    ws2Aux = await openWs(`${wsUrl}?aux=1`);
    ws1Aux.send(JSON.stringify({
      type: 'bind_aux', roomCode: 'DEDUP', clientId: 'c1'
    }));
    ws2Aux.send(JSON.stringify({
      type: 'bind_aux', roomCode: 'DEDUP', clientId: 'c2'
    }));
    await sleep(40);

    let rxEngineCalls = 0;
    const state = {
      peerConnected: true, rxCountThisSec: 0, lastRxInputAt: 0, maxRxGapMs: 0,
      lastRxInputDedupKey: '',
      engine: { receiveRemoteInputPacket: () => { rxEngineCalls++; } }
    };
    const dummyUi = { updateStatusStrip: () => {}, logDebug: () => {} };
    const dummyTel = {
      pushGameplayTelemetryToServer: () => {}, handlePongAndAutoDelay: () => {}
    };
    const proto = createProtocolHandlers(
      state, dummyUi, {}, { closeWebRtc: () => {} }, dummyTel
    );

    let rawWs2Frames = 0;
    const onRx = (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'netplay_input') rawWs2Frames++;
      proto.handleIncomingNetMessage(m);
    };
    ws2.on('message', onRx);
    ws2Aux.on('message', onRx);

    const pkts = [10, 11, 12].map((sf) => ({
      type: 'netplay_input', sessionId: 's1', player: 1,
      startFrame: sf, inputs: [sf & 3, 0]
    }));
    for (const p of pkts) ws1.send(JSON.stringify(p));
    await sleep(20);
    for (const p of pkts) ws1Aux.send(JSON.stringify(p));
    await sleep(40);

    assert.strictEqual(
      state.rxCountThisSec, 3,
      `Skewed wsAux duplicates leaked to client (${state.rxCountThisSec} != 3)`
    );
    assert.strictEqual(rxEngineCalls, 3);
    assert.ok(
      rawWs2Frames <= 6,
      `Server 4x amplified skewed Dual-WS packets (${rawWs2Frames} > 6)`
    );
  } finally {
    for (const w of [ws1, ws1Aux, ws2, ws2Aux]) { try { w?.close(); } catch {} }
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testZeroDelayHighRttNoStalls(localDir) {
  const nesDir = path.join(localDir, 'nes');
  const romFile = fs.readdirSync(nesDir).find((f) => f.endsWith('.nes'));
  const bin = fs.readFileSync(path.join(nesDir, romFile)).toString('binary');
  const n1 = new jsnes.NES({}), n2 = new jsnes.NES({});
  n1.loadROM(bin); n2.loadROM(bin);
  const e1 = new NesNetplayEngine(n1, {
    localPlayer: 1, online: true, inputDelayFrames: 0, enableRiftPacing: true
  });
  const e2 = new NesNetplayEngine(n2, {
    localPlayer: 2, online: true, inputDelayFrames: 0, enableRiftPacing: true
  });

  const q12 = [], q21 = [];
  let stepped1 = 0, stepped2 = 0, clump12 = 140, clump21 = 140;
  for (let tick = 0; tick < 240; tick++) {
    const now = tick * 16.667;
    while (q12.length && q12[0].at <= now) {
      e2.receiveRemoteInputPacket(q12.shift().p, now);
    }
    while (q21.length && q21[0].at <= now) {
      e1.receiveRemoteInputPacket(q21.shift().p, now);
    }
    const m1 = tick % 12 < 6 ? INPUT_BITS.RIGHT | INPUT_BITS.A : 0;
    const m2 = tick % 14 < 7 ? INPUT_BITS.LEFT | INPUT_BITS.B : 0;
    const r1 = e1.stepNetplayFrame(m1);
    const r2 = e2.stepNetplayFrame(m2);
    if (r1.stepped) stepped1++;
    if (r2.stepped) stepped2++;
    if (now + 140 > clump12) clump12 = now + 140 + (tick % 13 === 0 ? 210 : 0);
    if (now + 140 > clump21) clump21 = now + 140 + (tick % 11 === 0 ? 190 : 0);
    if (r1.packetToSend) q12.push({ at: clump12, p: r1.packetToSend });
    if (r2.packetToSend) q21.push({ at: clump21, p: r2.packetToSend });
  }
  assert.strictEqual(
    e1.stallFrames + e2.stallFrames, 0,
    `Expected 0 stalls on 280ms+210ms clump @ 0f, got ${e1.stallFrames}/` +
      `${e2.stallFrames}`
  );
  assert.strictEqual(
    e1.riftWaitFrames + e2.riftWaitFrames, 0,
    `Expected 0 rift frame-drops on clumped stream, got ${e1.riftWaitFrames}/` +
      `${e2.riftWaitFrames}`
  );
  assert.strictEqual(stepped1, 240, 'P1 must step all 240 frames smoothly');
  assert.strictEqual(stepped2, 240, 'P2 must step all 240 frames smoothly');
}

function testNoMidGameAutoDelayOscillation() {
  let setCalls = 0;
  const state = {
    rttMs: 275, jitterMs: 18, autoDelayCandidate: 4, autoDelayStreak: 0,
    lastAutoDelayChangeAt: -99999,
    engine: {
      currentFrame: 600, syncPaused: false, inputDelayFrames: 4,
      rxClumpFrames: 3, core: { systemId: 'nes' },
      setInputDelay(v) { this.inputDelayFrames = v; setCalls++; }
    }
  };
  const ui = {
    pingBadge: { textContent: '' }, dbgRtt: { textContent: '' },
    inputDelaySelect: { value: 'auto', querySelector: () => null },
    topInputDelaySelect: null, logDebug: () => {}
  };
  const rep = createTelemetryReporter(state, ui, {});
  for (const rtt of [325, 330, 328, 332]) {
    state.lastAutoDelayChangeAt = -99999;
    rep.handlePongAndAutoDelay({ type: 'peer_pong', t: Date.now() - rtt });
  }
  assert.strictEqual(
    setCalls, 0,
    'Auto Input Delay must NOT oscillate +/-1f mid-gameplay after frame 90!'
  );
}

async function testPinggy502OutageMultipartRecovery() {
  const t0 = Date.now();
  const mockFetch = async (url) => {
    if (url.includes('part=1&') && Date.now() - t0 < 500) {
      return { ok: false, status: 502 };
    }
    return { ok: true, status: 200 };
  };
  const ok = await uploadStripedRom(
    'http://127.0.0.1/api/room-rom?room=NOVA&crc=ABCD1234',
    new Uint8Array(400 * 1024), {},
    { fetchImpl: mockFetch, forceStriped: true }
  );
  assert.strictEqual(ok, true, 'Multipart upload must survive 500ms 502 blip');
}

export async function runTest11SmoothnessDedupAndUploadResilience(localDir) {
  await testSkewedDualWsDeduplication();
  testZeroDelayHighRttNoStalls(localDir);
  testNoMidGameAutoDelayOscillation();
  await testPinggy502OutageMultipartRecovery();
  console.log(
    '[PASS] Edge Case 10: Skewed Dual-WS Dedup, 0-Stall 280ms Rollback, ' +
      'Locked Mid-Game Auto-Delay & 500ms 502 Upload Recovery Verified'
  );
}
