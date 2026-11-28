// Deep Adversarial TDD Regressions for Audit P2-P3 & Real Chrome E2E
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCoopServer } from '../server/relay_server.mjs';
import { createNetTransport } from '../public/js/webrtc_p2p.mjs';
import { buildGameplayIceServers } from '../public/js/ice_config.mjs';
import { createAudioDrcEngine } from '../public/js/audio_drc.mjs';
import { handleRomTransferMessage } from '../public/js/rom_archive.mjs';
import { stepPacingAccumulator } from '../public/js/frame_loop.mjs';
import { setupHybridConnectionUi } from '../public/js/hybrid_connect.mjs';
import {
  findChromiumBinary, launchHeadlessBrowser, createCdpTab, waitFor,
  startRemoteProxy, sleep
} from './browser_cdp_harness.mjs';

async function testWebRtcClockStaleSyncCloseAndAnswererGuards() {
  let clock = 10000;
  const wsOut = [], rtcOut = [];
  const state = {
    ws: { readyState: 1, send: (d) => wsOut.push(d) },
    rtcChannel: { readyState: 'open', send: (d) => rtcOut.push(d) },
    wsAux: null, peerConnected: true, localPlayerIndex: 1,
    rttMs: 0, wssRttMs: 0, p2pRttMs: 0, jitterMs: 0,
    simLossPct: 0, simLagMs: 0, txCountThisSec: 0, rxCountThisSec: 0
  };
  const ui = {
    transportModeSelect: { value: 'auto' }, dbgRtcState: { textContent: '' },
    updateStatusStrip: () => {}, logDebug: () => {}
  };
  const tr = createNetTransport(state, ui, () => {}, { now: () => clock });
  state.recordPathRtt('p2p', 80); state.recordPathRtt('p2p', 82);
  state.recordPathRtt('wss', 150); state.recordPathRtt('wss', 152);
  const pkt = {
    type: 'netplay_input', sessionId: 's', startFrame: 1, inputs: [0]
  };
  tr.sendFastNetplayPacket(pkt);
  assert.strictEqual(rtcOut.length, 1);

  clock += 16000;
  state.recordPathRtt('wss', 150);
  wsOut.length = 0; rtcOut.length = 0;
  tr.sendFastNetplayPacket(pkt);
  assert.strictEqual(wsOut.length, 1, 'Stale P2P (>15s) did not fall back!');
  assert.strictEqual(rtcOut.length, 0);

  const syncChan = {
    readyState: 'open', onclose: null, close() { this.onclose?.(); }
  };
  state.rtcChannel = syncChan;
  syncChan.onclose = () => {
    if (state.rtcChannel === syncChan) state._usingP2pAuto = false;
  };
  tr.closeWebRtc();
  assert.strictEqual(state._usingP2pAuto, undefined);

  const origRtc = globalThis.RTCPeerConnection;
  const origDesc = globalThis.RTCSessionDescription;
  const peers = [];
  globalThis.RTCSessionDescription = class {
    constructor(x) { Object.assign(this, x); }
  };
  globalThis.RTCPeerConnection = class {
    constructor() {
      this.iceGatheringState = 'gathering'; this._ls = []; peers.push(this);
    }
    addEventListener(_e, fn) { this._ls.push(fn); }
    removeEventListener(_e, fn) { this._ls = this._ls.filter((f) => f !== fn); }
    finishGather() {
      this.iceGatheringState = 'complete';
      for (const fn of [...this._ls]) fn();
    }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    close() {}
  };
  try {
    wsOut.length = 0;
    const pAns = tr.handleWebRtcSignal({ sdp: { type: 'offer', sdp: 'v=0' } });
    await sleep(15);
    const ansPeer = peers[0];
    tr.closeWebRtc();
    ansPeer.finishGather();
    await pAns;
    assert.strictEqual(wsOut.length, 0, 'Answerer sent stale SDP!');

    await tr.startWebRtcSession(false);
    state.recordPathRtt('p2p', 70); state.recordPathRtt('p2p', 72);
    peers[1].connectionState = 'failed';
    peers[1].onconnectionstatechange?.();
    assert.strictEqual(
      state.multipathRacer.getScoreboard().some((r) => r.id === 'p2p'), false
    );
    assert.strictEqual(state._usingP2pAuto, false);
  } finally {
    globalThis.RTCPeerConnection = origRtc;
    globalThis.RTCSessionDescription = origDesc;
  }
  console.log('[PASS] Deep-1: WebRTC 15s Stale Fallback, Sync Close & Guards');
}

async function testStrictIceAudioResumeAuthGuardArchiveAndPacing() {
  for (const q of [
    '?turn=turn://bad.example:443&turnUser=u&turnPass=p',
    '?turn=turn::443&turnUser=u&turnPass=p',
    '?turn=turn:bad.example:99999&turnUser=u&turnPass=p',
    '?turn=stun:bad.example:3478?transport=tcp'
  ]) {
    const urls = buildGameplayIceServers({ search: q }).flatMap((s) =>
      Array.isArray(s.urls) ? s.urls : [s.urls]
    );
    const bad = urls.some(
      (u) => u.includes('bad.example') || u.includes('::443')
    );
    assert.strictEqual(bad, false, `Accepted bad ICE URL for ${q}`);
  }

  const prevWin = globalThis.window, prevAC = globalThis.AudioContext;
  const listeners = new Map();
  let stateStr = 'suspended', resumes = 0;
  class MockAC {
    constructor() { this.sampleRate = 48000; this.destination = {}; }
    get state() { return stateStr; }
    resume() {
      const n = ++resumes;
      return Promise.resolve().then(() => {
        if (n >= 2) stateStr = 'running';
      });
    }
  }
  globalThis.AudioContext = MockAC;
  globalThis.window = {
    AudioContext: MockAC,
    addEventListener(e, fn) {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e).add(fn);
    },
    removeEventListener(e, fn) { listeners.get(e)?.delete(fn); }
  };
  try {
    createAudioDrcEngine({});
    for (const fn of [...listeners.get('keydown')]) fn();
    await sleep(10);
    for (const fn of [...listeners.get('keydown')]) fn();
    await sleep(10);
    assert.strictEqual(stateStr, 'running');
    assert.strictEqual(resumes, 2, `Expected 2 resumes, got ${resumes}`);
  } finally {
    globalThis.window = prevWin; globalThis.AudioContext = prevAC;
  }

  const prevDoc = globalThis.document, prevLS = globalThis.localStorage;
  const prevFetch = globalThis.fetch;
  globalThis.window = { location: { search: '?static=1', hostname: 'x.io' } };
  globalThis.document = {
    getElementById: () => ({ value: 'pass99', addEventListener() {} }),
    createElement: () => ({ style: {}, addEventListener() {} })
  };
  globalThis.localStorage = {
    getItem: () => '', setItem() {}, removeItem() {}
  };
  globalThis.fetch = async () => ({ ok: false });
  try {
    const banners = [];
    const st = { usedNostrDiscovery: true, connStatus: { phase: 'error' } };
    const ui = {
      roomInput: { value: 'NOVA', addEventListener() {} },
      nickInput: { value: 'P2' }, dbgWssState: { textContent: '' },
      showScreenBanner: (b) => banners.push(b),
      logDebug() {}, updateStatusStrip() {}
    };
    const hc = setupHybridConnectionUi(st, ui, {
      connectStandardWs: () => {}, attachCustomSocket: () => {}
    });
    hc.schedulePinggyAutoReconnect();
    assert.strictEqual(banners.length, 0);
  } finally {
    globalThis.window = prevWin; globalThis.document = prevDoc;
    globalThis.localStorage = prevLS; globalThis.fetch = prevFetch;
  }

  const stArc = {
    engine: { syncPaused: true },
    incomingRomTransfer: {
      sessionId: 's_idx', romName: 'x.nes', payloadEncoding: 'identity',
      totalBytes: 8, totalChunks: 2, chunks: new Map(),
      endSeen: false, receivedBytes: 0, t0: 0, lastUiAt: 0, syncState: {}
    }
  };
  handleRomTransferMessage(
    {
      type: 'rom_chunk_data', sessionId: 's_idx', index: 99,
      data: new Uint8Array(4)
    }, stArc, { setTransferStatus() {}, logDebug() {}, showScreenBanner() {} },
    {}, () => {}, () => {}, () => new Uint8Array(0)
  );
  assert.strictEqual(stArc.incomingRomTransfer.chunks.size, 0);

  let acc = 0, skips = 0, doubles = 0;
  for (let i = 0; i < 600; i++) {
    const r = stepPacingAccumulator(acc, (i & 1) === 0 ? 15.2 : 18.1, 0, true);
    acc = r.accumulatorMs;
    let steps = 0;
    while (acc >= r.effectiveFrameMs) { acc -= r.effectiveFrameMs; steps++; }
    if (steps === 0) skips++;
    if (steps > 1) doubles++;
  }
  assert.strictEqual(skips, 0);
  assert.strictEqual(doubles, 0);
  console.log('[PASS] Deep-2: Strict ICE, Single Resume, Auth Guard & 60Hz');
}

async function testRealChromeNettestAuthHttpTunnelAndIce() {
  const bin = findChromiumBinary();
  if (!bin) return console.log('[SKIP] No local Chromium binary.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_deep_chr_'));
  const app = createCoopServer({ logAccess: false, logsDir: tmp });
  await app.beacon.setRoomPassword('NETAUTH', 'pw1234');
  const hostPort = await app.listen(0, '127.0.0.1');
  const remProxy = await startRemoteProxy(hostPort);
  let browser = null;
  try {
    browser = await launchHeadlessBrowser(bin, path.join(tmp, 'profile'));
    const tab = await createCdpTab(
      browser.debugPort,
      `http://127.0.0.2:${remProxy.port}/nettest?room=NETAUTH&pass=pw1234`
    );
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.WebSocket = class BlockedWs {
        constructor() {
          this.readyState = 3;
          setTimeout(() => {
            this.onerror?.(new Event('error'));
            this.onclose?.({ code: 1006, reason: 'Blocked' });
          }, 20);
        }
        send() {} close() {}
      };`
    });
    await tab.send('Page.reload', { ignoreCache: true });
    const httpState = await waitFor(() => tab.evaluate(`(() => {
      const s = document.getElementById('httpStateVal')?.textContent || '';
      const b = document.getElementById('roomBadge')?.textContent || '';
      if (s.includes('403')) throw new Error('HTTP tunnel got 403: ' + s);
      return s.includes('OPEN') && b.includes('NETAUTH') ? { s, b } : null;
    })()`), 12000, 'Authenticated /nettest HTTP-tunnel fallback');
    assert.ok(httpState.s.includes('OPEN'));

    const iceOk = await tab.evaluate(`(async () => {
      const { buildGameplayIceServers } = await import('/js/ice_config.mjs');
      for (const q of [
        '?turn=turn://bad.example:443&turnUser=u&turnPass=p',
        '?turn=turn::443&turnUser=u&turnPass=p',
        '?turn=turn:bad.example:99999&turnUser=u&turnPass=p',
        '?turn=stun:bad.example:3478?transport=tcp',
        '?turn=turn:nocred.example:443'
      ]) {
        const pc = new RTCPeerConnection({
          iceServers: buildGameplayIceServers({ search: q })
        });
        pc.close();
      }
      return true;
    })()`);
    assert.strictEqual(iceOk, true);
    assert.strictEqual(tab.exceptions.length, 0, tab.exceptions.join('; '));
    tab.close();
    console.log('[PASS] Deep-3: Real Chrome /nettest Auth HTTP-Tunnel & ICE');
  } finally {
    if (browser?.proc) {
      try { browser.proc.kill('SIGKILL'); } catch {}
      await sleep(150);
    }
    await remProxy.close();
    await app.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log('=== Deep Adversarial Audit Regression Suite ===\n');
  await testWebRtcClockStaleSyncCloseAndAnswererGuards();
  await testStrictIceAudioResumeAuthGuardArchiveAndPacing();
  await testRealChromeNettestAuthHttpTunnelAndIce();
  console.log('\nALL DEEP ADVERSARIAL AUDIT REGRESSIONS PASSED!');
}

main().catch((err) => {
  console.error('\n[FAIL] Deep Audit Regressions:', err);
  process.exit(1);
});
