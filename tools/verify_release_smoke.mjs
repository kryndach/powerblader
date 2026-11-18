// Pre-Release Build Smoke Gate & Gameplay-vs-Autotest Ping Bloat Regressions
import assert from 'assert';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import * as jsnesModule from 'jsnes';
import { NesNetplayEngine, INPUT_BITS } from '../src/netplay_engine.mjs';
import { createCoopServer } from '../server/relay_server.mjs';
import { resolveSshBin } from '../server/tunnel_manager.mjs';
import { createNetTransport } from '../public/js/webrtc_p2p.mjs';
import { createTelemetryReporter } from '../public/js/telemetry_reporter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpReq(port, urlPath, method = 'GET', bodyObj = null) {
  return new Promise((resolve, reject) => {
    const raw = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: raw ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw)
      } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

function testCompactAckInputsAndHashCadence() {
  const nesDir = path.join(ROOT_DIR, 'local', 'nes');
  const romFile = fs.readdirSync(nesDir).find((f) => f.endsWith('.nes'));
  const romBin = fs.readFileSync(path.join(nesDir, romFile), 'binary');
  const n1 = new jsnes.NES({}); n1.loadROM(romBin);
  const n2 = new jsnes.NES({}); n2.loadROM(romBin);
  const e1 = new NesNetplayEngine(n1, {
    localPlayer: 1, online: true, inputDelayFrames: 4, maxRollbackFrames: 56,
    enableRiftPacing: false
  });
  const e2 = new NesNetplayEngine(n2, {
    localPlayer: 2, online: true, inputDelayFrames: 4, maxRollbackFrames: 56,
    enableRiftPacing: false
  });
  e1.resetTimeline(0, 's_ack');
  e2.resetTimeline(0, 's_ack');

  const q12 = [], q21 = [];
  let postWarmupLenSum = 0, postWarmupCount = 0, hashPkts = 0;
  const ONE_WAY_FRAMES = 7; // ~116ms each way = ~232ms RTT

  for (let tick = 0; tick < 120; tick++) {
    while (q12.length > 0 && q12[0].deliverAt <= tick) {
      e2.receiveRemoteInputPacket(q12.shift().pkt, tick * 16.67);
    }
    while (q21.length > 0 && q21[0].deliverAt <= tick) {
      e1.receiveRemoteInputPacket(q21.shift().pkt, tick * 16.67);
    }
    const m1 = (tick % 5 < 2 ? INPUT_BITS.RIGHT : 0) |
      (tick % 7 === 0 ? INPUT_BITS.A : 0);
    const m2 = (tick % 6 < 3 ? INPUT_BITS.LEFT : 0) |
      (tick % 9 === 0 ? INPUT_BITS.B : 0);
    const r1 = e1.stepNetplayFrame(m1);
    const r2 = e2.stepNetplayFrame(m2);
    if (r1.packetToSend) {
      if (r1.packetToSend.hashFrame !== undefined) hashPkts++;
      if (tick >= 35) {
        postWarmupLenSum += r1.packetToSend.inputs.length;
        postWarmupCount++;
      }
      q12.push({ deliverAt: tick + ONE_WAY_FRAMES, pkt: r1.packetToSend });
    }
    if (r2.packetToSend) {
      q21.push({ deliverAt: tick + ONE_WAY_FRAMES, pkt: r2.packetToSend });
    }
  }
  const avgInputsLen = postWarmupLenSum / Math.max(1, postWarmupCount);
  assert.strictEqual(e1.desyncCount, 0, 'Ack-windowed stream must not desync');
  assert.strictEqual(e2.desyncCount, 0, 'Ack-windowed stream must not desync');
  assert.ok(
    avgInputsLen <= 22,
    `Expected compact ack-windowed inputs <= 22, got ${avgInputsLen.toFixed(1)}`
  );
  assert.ok(
    hashPkts <= 6,
    `Expected hashFrame only on new 30f hashes (<=6), got ${hashPkts}/120`
  );
}

async function testNo100PctAuxDuplicationAndOffSocketTelemetry() {
  let wsSent = 0, auxSent = 0;
  const state = {
    ws: { readyState: 1, send: () => { wsSent++; } },
    wsAux: { readyState: 1, send: () => { auxSent++; } },
    rtcChannel: null, simLossPct: 0, simLagMs: 0, txCountThisSec: 0,
    localPlayerIndex: 1, roomCode: 'NOVA', peerConnected: true,
    romName: 'Battletoads.nes', romCrc32: '53B02F3D',
    partnerRomCrc32: '53B02F3D', rttMs: 215, jitterMs: 12,
    lastFpsVal: 60, txPerSec: 60, rxPerSec: 60, maxRxGapMs: 32,
    telemetrySamples: [], telemetryEvents: []
  };
  const ui = {
    transportModeSelect: { value: 'wss' },
    inputDelaySelect: { value: '4', querySelector: () => null },
    dbgRtcState: { textContent: '' },
    pingBadge: { textContent: '' },
    dbgRtt: { textContent: '' },
    updateStatusStrip: () => {}, logDebug: () => {}
  };
  const origWin = globalThis.window;
  globalThis.window = { location: { protocol: 'http:', host: 'localhost' } };
  try {
    const tr = createNetTransport(state, ui, () => {});
    for (let f = 1; f <= 60; f++) {
      const pkt = {
        type: 'netplay_input', sessionId: 's1', player: 1, startFrame: f,
        inputs: [f & 3, (f - 1) & 3, 0],
        ...(f % 30 === 0 ? { hashFrame: f, hash: 1234 } : {})
      };
      tr.sendFastNetplayPacket(pkt);
    }
    assert.strictEqual(wsSent, 60);
    assert.ok(
      auxSent <= 34,
      `wsAux duplicated ${auxSent}/60 packets (expected <=34 even-stripe)`
    );
  } finally {
    globalThis.window = origWin;
  }

  let wsBefore = wsSent, httpPosts = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/api/gameplay-telemetry') &&
        opts?.method === 'POST') {
      httpPosts++;
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  try {
    const tel = createTelemetryReporter(state, ui, {});
    await tel.pushGameplayTelemetryToServer();
    assert.strictEqual(
      wsSent - wsBefore, 0,
      'Gameplay telemetry must NOT clog live state.ws WebSocket!'
    );
    assert.strictEqual(httpPosts, 1, 'Gameplay telemetry must POST via HTTP');
  } finally {
    globalThis.fetch = origFetch;
  }
}

async function testServerWireRttAndRawInputFastPath() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_wire_'));
  const app = createCoopServer({
    logAccess: false, logsDir: tmp, wirePingIntervalMs: 120
  });
  const port = await app.listen(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const open = () => new Promise((res, rej) => {
    const w = new WebSocket(wsUrl);
    w.once('open', () => res(w));
    w.once('error', rej);
  });
  let p1, p2;
  try {
    p1 = await open();
    p2 = await open();
    let p1Wire = null, p2Wire = null, rxInputMsg = null;
    p1.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'wire_rtt') p1Wire = m;
    });
    p2.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'wire_rtt') p2Wire = m;
      if (m.type === 'netplay_input') rxInputMsg = m;
    });
    p1.send(JSON.stringify({
      type: 'join_room', roomCode: 'WRTT', nick: 'P1'
    }));
    p2.send(JSON.stringify({
      type: 'join_room', roomCode: 'WRTT', nick: 'P2'
    }));
    await sleep(340);

    assert.ok(p1Wire && typeof p1Wire.rttMs === 'number', 'P1 no wire_rtt');
    assert.ok(p2Wire && typeof p2Wire.rttMs === 'number', 'P2 no wire_rtt');
    assert.ok(p1Wire.rttMs < 50, `Local wire_rtt high: ${p1Wire.rttMs}`);

    p1.send(JSON.stringify({
      type: 'netplay_input', sessionId: 's', player: 1,
      startFrame: 50, inputs: [1]
    }));
    await sleep(50);
    assert.ok(rxInputMsg, 'P2 must receive relayed netplay_input');
    assert.strictEqual(
      rxInputMsg.fromNick, undefined,
      'netplay_input WS relay must not inject bloated fromNick metadata'
    );
    assert.strictEqual(
      rxInputMsg.serverRxTime, undefined,
      'netplay_input WS relay must not inject bloated serverRxTime metadata'
    );
  } finally {
    try { p1?.close(); p2?.close(); } catch {}
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function verifyLaunchersPs1AndLiveServer(liveTunnel = false) {
  const batFiles = fs.readdirSync(ROOT_DIR).filter((f) =>
    /^PLAY_NES_.*\.bat$/i.test(f)
  );
  assert.ok(batFiles.length >= 6, 'Expected all PLAY_NES_*.bat launchers');
  for (const bf of batFiles) {
    const txt = fs.readFileSync(path.join(ROOT_DIR, bf), 'utf8');
    assert.ok(txt.includes('start_online.ps1'), `${bf} missing ps1`);
  }

  const ps1Path = path.join(ROOT_DIR, 'start_online.ps1');
  const ps1Bytes = fs.readFileSync(ps1Path);
  const nonAscii = ps1Bytes.find((b) => b > 127);
  assert.strictEqual(nonAscii, undefined, 'start_online.ps1 non-ASCII');

  if (process.platform === 'win32') {
    const parseCmd =
      '$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]' +
      `::ParseFile('${ps1Path.replace(/'/g, "''")}',[ref]$t,[ref]$e);` +
      'if($e.Count -gt 0){$e|Out-String|Write-Error;exit 1}';
    execFileSync('powershell', ['-NoProfile', '-Command', parseCmd], {
      stdio: 'pipe'
    });
  }

  execFileSync(resolveSshBin('ssh'), ['-V'], { stdio: 'pipe' });
  const keyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_kgen_'));
  try {
    execFileSync(
      resolveSshBin('ssh-keygen'),
      ['-t', 'ed25519', '-f', path.join(keyTmp, 'k'), '-q', '-N', ''],
      { stdio: 'pipe' }
    );
  } finally {
    fs.rmSync(keyTmp, { recursive: true, force: true });
  }

  const probePort = 18940 + Math.floor(Math.random() * 500);
  const stderrChunks = [];
  const child = spawn(
    process.execPath, ['server/relay_server.mjs'],
    {
      cwd: ROOT_DIR,
      env: { ...process.env, PORT: String(probePort) },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  child.stderr.on('data', (c) => stderrChunks.push(String(c)));
  try {
    let healthy = false;
    for (let i = 0; i < 25; i++) {
      await sleep(150);
      try {
        const h = await httpReq(probePort, '/api/health');
        if (h.status === 200 && JSON.parse(h.body).ok) {
          healthy = true;
          break;
        }
      } catch {}
    }
    assert.ok(healthy, 'Real child server/relay_server.mjs failed /api/health');
    for (const p of ['/', '/autotest', '/nettest', '/vendor/jsnes.js']) {
      const r = await httpReq(probePort, p);
      assert.strictEqual(r.status, 200, `Asset ${p} returned ${r.status}`);
    }
    if (liveTunnel) {
      const tRes = await httpReq(
        probePort, '/api/tunnel-routes', 'POST', { route: 'auto' }
      );
      assert.strictEqual(tRes.status, 200, `Live tunnel failed: ${tRes.body}`);
      const tj = JSON.parse(tRes.body);
      assert.ok(
        String(tj.tunnelInfo?.publicUrl || '').startsWith('https://'),
        'Live auto-tunnel did not return https:// publicUrl'
      );
    }
    assert.strictEqual(
      stderrChunks.join('').trim(), '',
      `Unexpected relay_server.mjs stderr: ${stderrChunks.join('')}`
    );
  } finally {
    if (process.platform === 'win32' && child.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore'
        });
      } catch {}
    } else {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
}

async function main() {
  const liveTunnel = process.argv.includes('--live-tunnel');
  testCompactAckInputsAndHashCadence();
  await testNo100PctAuxDuplicationAndOffSocketTelemetry();
  await testServerWireRttAndRawInputFastPath();
  await verifyLaunchersPs1AndLiveServer(liveTunnel);
  console.log(
    `[PASS] Pre-Release Build Gate, Compact Wire Protocol & C++ Wire-RTT` +
      `${liveTunnel ? ' + Live Pinggy Tunnel' : ''} Verified`
  );
}

main().catch((err) => {
  console.error('\n[FAIL] Release Smoke / Wire Bloat Gate Failed:', err);
  process.exit(1);
});
