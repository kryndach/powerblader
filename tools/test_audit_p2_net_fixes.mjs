// TDD Regression Suite: Audit Priority 2a (Auth, Routes, WebRTC Racer)
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCoopServer } from '../server/relay_server.mjs';
import { createSaveSlotsManager } from '../public/js/save_slots.mjs';
import {
  buildMigratedClientUrl, createRouteOptimizer
} from '../public/js/route_optimizer.mjs';
import { createNetTransport } from '../public/js/webrtc_p2p.mjs';
import { createTelemetryReporter } from '../public/js/telemetry_reporter.mjs';
import { getActiveTransportLabel } from '../public/js/connection_status_ui.mjs';
import { resetPingWindow } from '../public/js/session_store.mjs';

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

async function testP2_5AuthOnSaveSlotsAndNetDebugHttpTunnel() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_p2_5_'));
  const app = createCoopServer({
    logAccess: false, logsDir: tmp, savesDir: path.join(tmp, 'saves')
  });
  await app.beacon.setRoomPassword('NOVA', 'pw1234');
  const authToken = app.beacon.getRoomAuthStatus().authToken;
  const port = await app.listen(0, '127.0.0.1');
  const prevFetch = globalThis.fetch;
  const statuses = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const r = await httpReq(
      port, `${u.pathname}${u.search}`, opts.method || 'GET', opts.body,
      { ...(opts.headers || {}), Host: 'guest.run.pinggy-free.link' }
    );
    statuses.push({ m: opts.method || 'GET', p: u.pathname, st: r.status });
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status,
      json: async () => JSON.parse(r.body)
    };
  };
  try {
    const state = {
      apiBaseUrl: `http://127.0.0.1:${port}`, isStaticOrigin: true,
      roomAuth: authToken, romCrc32: 'FACE1234', romName: 'Test.nes',
      nes: { ppu: { buffer: new Uint32Array(16) } },
      engine: {
        exportSyncState: () => ({ frame: 42, nesState: {} }),
        importSyncState: () => {}
      },
      localPlayerIndex: 1
    };
    const ui = {
      saveSlotSelect: {
        value: '1', querySelector: () => ({ textContent: '' })
      },
      showScreenBanner: () => {}, logDebug: () => {},
      renderFrameToCanvas: () => {}, updateStatusStrip: () => {}
    };
    const rs = { resolveDesiredInputDelay: () => 2 };
    const mgr = createSaveSlotsManager(state, ui, rs);
    mgr.saveToCurrentSlot();
    await new Promise((r) => setTimeout(r, 40));
    mgr.updateSlotSelectLabels();
    await new Promise((r) => setTimeout(r, 40));

    const mgr2 = createSaveSlotsManager(state, ui, rs);
    assert.strictEqual(await mgr2.loadFromCurrentSlot(), true);
    assert.ok(statuses.length >= 3);
    for (const s of statuses) {
      assert.strictEqual(s.st, 200, `${s.m} ${s.p} returned HTTP ${s.st}`);
    }

    const dbgSrc = fs.readFileSync(
      path.join(ROOT, 'public/js/net_debug_app.mjs'), 'utf8'
    );
    const pollBlock = dbgSrc.slice(
      dbgSrc.indexOf('async function pollHttpTunnel'),
      dbgSrc.indexOf('async function connectRoom')
    );
    assert.ok(
      pollBlock.includes('X-Room-Auth') && pollBlock.includes('roomAuth'),
      'net_debug_app.mjs pollHttpTunnel omits roomAuth!'
    );
    console.log('[PASS] P2-5: Room Auth on /api/save-slot & /api/http-tunnel');
  } finally {
    globalThis.fetch = prevFetch;
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testP2_6RouteMigrationStaticOriginAndParams() {
  // 1. Preserve pass, turn, turnUser, turnPass, relays
  const curHref =
    'https://old.pinggy.link/?room=NOVA&nick=P2&debug=1&pass=sec99' +
    '&turn=turn:my.t:443&turnUser=u1&turnPass=p1&relays=wss://r1.test';
  const u = new URL(buildMigratedClientUrl('https://fast.pinggy.link', curHref));
  assert.strictEqual(u.searchParams.get('room'), 'NOVA');
  assert.strictEqual(u.searchParams.get('pass'), 'sec99');
  assert.strictEqual(u.searchParams.get('turn'), 'turn:my.t:443');
  assert.strictEqual(u.searchParams.get('turnUser'), 'u1');
  assert.strictEqual(u.searchParams.get('turnPass'), 'p1');
  assert.strictEqual(u.searchParams.get('relays'), 'wss://r1.test');
  assert.strictEqual(u.searchParams.get('optimized'), '1');

  // 2. Nostr Guest on GitHub Pages must NOT persist ephemeral ?server=
  let replacedUrl = null;
  const prevWin = globalThis.window;
  try {
    globalThis.window = {
      location: {
        href: 'https://user.github.io/NES_Online/?room=NOVA',
        search: '?room=NOVA', replace: () => {}
      },
      history: {
        replaceState: (_s, _t, next) => { replacedUrl = String(next); }
      }
    };
    const state = {
      isStaticOrigin: true, usedNostrDiscovery: true, isExternalServer: true,
      apiBaseUrl: 'https://old.pinggy.link', wsBaseUrl: 'wss://old.pinggy.link'
    };
    const opt = createRouteOptimizer(
      state, { logDebug() {}, showScreenBanner() {} }, null,
      { onHotRouteSwitch: () => {} }
    );
    await opt.handleRouteMessage({
      type: 'route_migrate', url: 'https://ephem.pinggy.link',
      label: 'Pinggy SG', rttMs: 90
    });
    assert.ok(
      !replacedUrl || !replacedUrl.includes('server='),
      `Nostr Guest URL polluted with ?server=: ${replacedUrl}`
    );
  } finally {
    globalThis.window = prevWin;
  }
  console.log('[PASS] P2-6: Route Migration Params & No Static ?server= Trap');
}

async function testP2_7WebRtcRacerJitterStaleRemoteRelayAndGuards() {
  const wsOut = [], rtcOut = [];
  const state = {
    ws: { readyState: 1, send: (d) => wsOut.push(d) },
    rtcChannel: { readyState: 'open', send: (d) => rtcOut.push(d) },
    wsAux: null, peerConnected: true, localPlayerIndex: 1,
    rttMs: 0, wssRttMs: 0, p2pRttMs: 0, jitterMs: 0,
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
  const tr = createNetTransport(state, ui, () => {});
  const tel = createTelemetryReporter(state, ui, {});

  // 1. Oscillating P2P samples via telemetry -> 60Hz send must keep jitterMs
  const now = Date.now();
  tel.handlePongAndAutoDelay({ type: 'peer_pong', t: now - 120 }, 'p2p');
  tel.handlePongAndAutoDelay({ type: 'peer_pong', t: now - 200 }, 'p2p');
  tel.handlePongAndAutoDelay({ type: 'peer_pong', t: now - 130 }, 'p2p');
  tel.handlePongAndAutoDelay({ type: 'peer_pong', t: now - 150 }, 'wss');
  tel.handlePongAndAutoDelay({ type: 'peer_pong', t: now - 152 }, 'wss');
  for (let f = 0; f < 60; f++) {
    tr.sendFastNetplayPacket({
      type: 'netplay_input', sessionId: 's1', startFrame: f, inputs: [0]
    });
  }
  const board = state.multipathRacer.getScoreboard();
  const p2pRow = board.find((r) => r.id === 'p2p');
  assert.ok(p2pRow && p2pRow.jitterMs > 20, '60Hz send wiped P2P jitterMs');

  // 2. When _usingP2pAuto === false, UI & telemetry must NOT say WebRTC P2P
  state._usingP2pAuto = false;
  assert.notStrictEqual(getActiveTransportLabel(state, ui), 'WebRTC P2P');
  let postedTel = null;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (_u, o) => {
    postedTel = JSON.parse(o.body);
    return { ok: true };
  };
  try {
    await tel.pushGameplayTelemetryToServer();
    assert.strictEqual(postedTel.transport, 'WSS Relay');
  } finally {
    globalThis.fetch = prevFetch;
  }

  // 3. resetPingWindow clears p2pRttMs, wssRttMs, _usingP2pAuto & racer
  resetPingWindow(state);
  assert.strictEqual(state.p2pRttMs, 0);
  assert.strictEqual(state.wssRttMs, 0);
  assert.strictEqual(state._usingP2pAuto, undefined);
  assert.strictEqual(state.multipathRacer.getScoreboard().length, 0);

  // 4. Guards across waitForRtcGathering + remote relay + channel.onclose
  const origRtc = globalThis.RTCPeerConnection;
  const origDesc = globalThis.RTCSessionDescription;
  const createdPeers = [], createdChans = [];
  globalThis.RTCSessionDescription = class {
    constructor(x) { Object.assign(this, x); }
  };
  globalThis.RTCPeerConnection = class MockRtc {
    constructor() {
      this.iceGatheringState = 'gathering';
      this._listeners = [];
      createdPeers.push(this);
    }
    addEventListener(ev, fn) { this._listeners.push([ev, fn]); }
    removeEventListener(ev, fn) {
      this._listeners = this._listeners.filter((x) => x[1] !== fn);
    }
    finishGather() {
      this.iceGatheringState = 'complete';
      for (const [, fn] of [...this._listeners]) fn();
    }
    createDataChannel() {
      const ch = { readyState: 'open', send() {}, close() {} };
      createdChans.push(ch);
      return ch;
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async getStats() {
      return new Map([
        ['p1', {
          type: 'candidate-pair', selected: true,
          localCandidateId: 'loc1', remoteCandidateId: 'rem1'
        }],
        ['loc1', { protocol: 'udp', candidateType: 'srflx' }],
        ['rem1', { protocol: 'udp', candidateType: 'relay' }]
      ]);
    }
    close() {}
  };
  try {
    wsOut.length = 0;
    const pStart = tr.startWebRtcSession(true);
    await new Promise((r) => setTimeout(r, 15));
    const stalePeer = createdPeers[0];
    tr.closeWebRtc();
    stalePeer.finishGather();
    await pStart;
    assert.strictEqual(wsOut.length, 0, 'Stale rtcPeer sent SDP after close!');
    stalePeer._sdpSent = true;
    stalePeer.onicecandidate?.({ candidate: { candidate: 'stale_ice' } });
    assert.strictEqual(wsOut.length, 0, 'Stale rtcPeer sent ICE after close!');

    const pStart2 = tr.startWebRtcSession(true);
    await new Promise((r) => setTimeout(r, 10));
    createdPeers[1].finishGather();
    await pStart2;
    createdChans[1].onopen();
    await new Promise((r) => setTimeout(r, 450));
    assert.strictEqual(state.rtcPathKind, 'turn_443');
    state.multipathRacer.recordSample('p2p', { kind: 'turn_443', rttMs: 100 });
    createdChans[1].onclose();
    assert.strictEqual(
      state.multipathRacer.getScoreboard().some((r) => r.id === 'p2p'), false
    );
  } finally {
    globalThis.RTCPeerConnection = origRtc;
    globalThis.RTCSessionDescription = origDesc;
  }
  console.log('[PASS] P2-7: Multi-Path Racer, Remote Relay, Guards & Labels');
}

async function main() {
  console.log('=== Audit Priority 2a (Network) Regression Suite ===\n');
  await testP2_5AuthOnSaveSlotsAndNetDebugHttpTunnel();
  await testP2_6RouteMigrationStaticOriginAndParams();
  await testP2_7WebRtcRacerJitterStaleRemoteRelayAndGuards();
  console.log('\nALL AUDIT PRIORITY 2A TESTS PASSED!');
}

main().catch((err) => {
  console.error('\n[FAIL] Audit P2a Suite:', err);
  process.exit(1);
});
