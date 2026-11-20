// Real-Life SG-RU 250ms Smoothness & Arcade Frame-Budget Gate
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createFbneoArcadeCore } from '../src/fbneo_arcade_core.mjs';
import { RollbackNetplayEngine, INPUT_BITS } from '../src/netplay_engine.mjs';
import { extractRomFromFile } from '../server/archive_extractor.mjs';
import { createCoopServer } from '../server/relay_server.mjs';
import {
  sleep, findChromiumBinary, createCdpTab, waitFor, launchHeadlessBrowser
} from './browser_cdp_harness.mjs';
import { startNetemProxy } from './netem_proxy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

async function testArcadeTgm2pStreamingRollbackBudget() {
  const romPath = path.join(ROOT_DIR, 'local', 'arcade', 'tgm2p.zip');
  if (!fs.existsSync(romPath)) {
    console.log('[SKIP] local/arcade/tgm2p.zip not present');
    return;
  }
  const ext = extractRomFromFile(romPath);
  const romBytes = new Uint8Array(ext.romBuffer);
  const c1 = await createFbneoArcadeCore({ romBytes, romName: ext.romName });
  const cRef = await createFbneoArcadeCore({ romBytes, romName: ext.romName });
  let saveCallsInRollback = 0, inRbMeasure = false;
  const origSaveInto = c1.saveStateInto;
  c1.saveStateInto = function (...a) {
    if (inRbMeasure) saveCallsInRollback++;
    return origSaveInto.apply(this, a);
  };
  const eng = new RollbackNetplayEngine(c1, {
    localPlayer: 1, online: true, inputDelayFrames: 0, maxRollbackFrames: 24
  });
  eng.resetTimeline(0, 's_tgm_budget');

  for (let f = 0; f < 60; f++) {
    eng.receiveRemoteInputPacket({
      type: 'netplay_input', sessionId: 's_tgm_budget', player: 2,
      startFrame: f, inputs: [0]
    });
    eng.stepNetplayFrame(0);
    cRef.stepFrame(0, 0, true);
  }

  // Simulate continuous 240ms SG-RU stream (7f one-way lag) with P2 tapping
  // every frame! Verifies: (1) coalescing prevents 60Hz consecutive rollbacks,
  // (2) <=2 saves per rollback (not 7+), (3) 5f-7f RB stays fast, (4) 0 desync.
  const ONE_WAY = 7;
  const p2Hist = new Map();
  const rbTimes = [], rbSaves = [];
  for (let f = 60; f < 170; f++) {
    const m1 = (f % 6 < 3 ? INPUT_BITS.LEFT : INPUT_BITS.RIGHT);
    const m2 = (f % 4 < 2 ? INPUT_BITS.RIGHT : 0) |
      (f % 5 === 0 ? INPUT_BITS.A : 0);
    p2Hist.set(f, m2);
    cRef.stepFrame(m1, m2, true);

    const arrFrame = f - ONE_WAY;
    if (arrFrame >= 60) {
      const inputs = [];
      for (let k = 0; k < 14 && arrFrame - k >= 60; k++) {
        inputs.push(p2Hist.get(arrFrame - k) || 0);
      }
      eng.receiveRemoteInputPacket({
        type: 'netplay_input', sessionId: 's_tgm_budget', player: 2,
        startFrame: arrFrame, inputs
      });
    }
    const rbBefore = eng.rollbacksTotal;
    saveCallsInRollback = 0;
    inRbMeasure = true;
    const t0 = performance.now();
    eng.stepNetplayFrame(m1);
    const dt = performance.now() - t0;
    inRbMeasure = false;
    if (eng.rollbacksTotal > rbBefore) {
      rbTimes.push(dt);
      // Subtract 1 for the normal post-rollback frame save
      rbSaves.push(Math.max(0, saveCallsInRollback - 1));
    }
  }

  // Drain remaining 7 frames so both cores converge on exact same state
  const finalInputs = [];
  for (let k = 0; k < 16; k++) finalInputs.push(p2Hist.get(169 - k) || 0);
  eng.receiveRemoteInputPacket({
    type: 'netplay_input', sessionId: 's_tgm_budget', player: 2,
    startFrame: 169, inputs: finalInputs
  });
  for (let k = 0; k < 4; k++) {
    eng.receiveRemoteInputPacket({
      type: 'netplay_input', sessionId: 's_tgm_budget', player: 2,
      startFrame: 170 + k, inputs: [0]
    });
    eng.stepNetplayFrame(0);
    cRef.stepFrame(0, 0, true);
  }

  const sorted = [...rbTimes].sort((a, b) => a - b);
  const medRb = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const maxSaves = Math.max(0, ...rbSaves);
  assert.strictEqual(
    c1.computeHash(), cRef.computeHash(),
    'Coalesced sparse-checkpoint tgm2p.zip diverged from reference core!'
  );
  assert.ok(
    rbTimes.length <= 40,
    `Coalescing failed: ${rbTimes.length} rollbacks in 110 frames`
  );
  assert.ok(
    maxSaves <= 2,
    `Redundant saves inside Arcade rollback: ${maxSaves} (expected <=2)`
  );
  assert.ok(
    medRb <= 34.0,
    `Arcade tgm2p.zip 7-9f streaming RB median=${medRb.toFixed(1)}ms (>34ms)`
  );
  console.log(
    `[PASS] Arcade tgm2p.zip 240ms 0f-Delay: RB=${rbTimes.length}/110f ` +
      `(coalesced, saves<=${maxSaves}, med=${medRb.toFixed(1)}ms, 0 desyncs)`
  );
}

async function testChromePinggy250msNetemSmoothness() {
  const bin = findChromiumBinary();
  if (!bin) return console.log('[SKIP] No local Chrome/Edge binary found.');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_netem_e2e_'));
  const app = createCoopServer({
    logAccess: false, logsDir: path.join(tmpDir, 'logs'),
    wirePingIntervalMs: 400
  });
  const hostPort = await app.listen(0, '127.0.0.1');
  const proxy = await startNetemProxy(hostPort, { rttMs: 0 });
  let browser = null;
  try {
    browser = await launchHeadlessBrowser(bin, path.join(tmpDir, 'profile'));
    const tab1 = await createCdpTab(
      browser.debugPort,
      `http://127.0.0.1:${hostPort}/?room=NETEM&nick=HostSG&debug=1`
    );
    const tab2 = await createCdpTab(
      browser.debugPort,
      `http://127.0.0.2:${proxy.port}/?room=NETEM&nick=BroRU&debug=1`
    );
    await waitFor(() => tab1.evaluate(
      `document.getElementById('lobbyP2Name')?.textContent.includes('BroRU')`
    ), 10000, 'Both tabs joined NETEM');

    // Force WSS Relay (matching SG-RU where UDP P2P is blocked by ISP/zapret)
    // so Chrome cannot bypass netem_proxy over localhost WebRTC UDP!
    const forceWss = `(() => {
      const m = document.getElementById('transportModeSelect');
      if (m) m.value = 'wss';
    })()`;
    await Promise.all([tab1.evaluate(forceWss), tab2.evaluate(forceWss)]);

    await tab1.evaluate(`(() => {
      const sel = document.getElementById('localRomSelect');
      const opts = [...sel.options].map((o) => o.value).filter(Boolean);
      const pick = opts.find((v) => v.toLowerCase().includes('battletoads')) ||
        opts[0];
      sel.value = pick;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(() => tab1.evaluate(
      `document.getElementById('romBadge')?.textContent.includes('[')`
    ), 12000, 'Host loaded Battletoads');
    await tab1.evaluate(
      `document.getElementById('topSendRomBtn').click(); true`
    );
    await waitFor(() => tab1.evaluate(
      `Number(document.getElementById('dbgFrame')?.textContent) >= 20`
    ), 15000, 'Lockstep started');

    proxy.resetStats();
    proxy.setProfile({
      rttMs: 240, jitterMs: 20, kbpsCap: 170,
      clumpEveryMs: 1400, clumpHoldMs: 120
    });

    const startProbeJs = `(() => {
      window.__rafDeltas = [];
      let prev = performance.now();
      window.__probeRun = true;
      function tick(now) {
        if (!window.__probeRun) return;
        window.__rafDeltas.push(now - prev);
        prev = now;
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      let step = 0;
      window.__keyTimer = setInterval(() => {
        const down = (step++ & 1) === 0;
        window.dispatchEvent(new KeyboardEvent(
          down ? 'keydown' : 'keyup', { code: 'ArrowRight' }
        ));
      }, 180);
    })()`;
    await tab1.evaluate(startProbeJs);
    await tab2.evaluate(startProbeJs);
    await sleep(3200);

    const stopJs = `(() => {
      window.__probeRun = false;
      clearInterval(window.__keyTimer);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowRight' }));
      const d = window.__rafDeltas.slice(5).sort((a, b) => a - b);
      const p95 = d[Math.floor(d.length * 0.95)] || 0;
      const freezes = d.filter((x) => x > 45).length;
      return {
        p95: Math.round(p95), freezes,
        ping: document.getElementById('pingBadge')?.textContent || '',
        desyncs: document.getElementById('dbgDesyncs')?.textContent || '0',
        frame: Number(document.getElementById('dbgFrame')?.textContent || 0)
      };
    })()`;
    const [m1, m2] = await Promise.all([
      tab1.evaluate(stopJs), tab2.evaluate(stopJs)
    ]);
    const stats = proxy.getStats();
    const avgKbps = Math.round((stats.bytesUp + stats.bytesDown) / 3.2 / 1024);
    const pingNum = Number((/\d+/.exec(m1.ping) || [0])[0]);

    assert.strictEqual(m1.desyncs, '0', 'P1 desynced under 240ms Pinggy netem');
    assert.strictEqual(m2.desyncs, '0', 'P2 desynced under 240ms Pinggy netem');
    assert.ok(
      m1.frame >= 140 && m2.frame >= 140,
      `Low frame progress: ${m1.frame}/${m2.frame}`
    );
    assert.ok(avgKbps <= 65, `Wire traffic bloated (${avgKbps} KB/s > 65)`);
    assert.ok(
      pingNum >= 180 && pingNum <= 330,
      `Displayed ping out of bounds on 240ms netem: ${m1.ping}`
    );
    assert.ok(m1.freezes <= 3, `Tab 1 had ${m1.freezes} >45ms freezes`);
    console.log(
      `[PASS] Real Chrome 240ms Pinggy Netem E2E: ${m1.ping}, ` +
        `Wire=${avgKbps}KB/s, F=${m1.frame}/${m2.frame}, ` +
        `Freezes=${m1.freezes}, 0 Desyncs`
    );
    try { tab1.close(); tab2.close(); } catch {}
  } finally {
    if (browser?.proc) {
      try { browser.proc.kill('SIGKILL'); } catch {}
      await sleep(150);
    }
    await proxy.close();
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log('=== Real-Life SG-RU Smoothness & Frame-Budget Suite ===\n');
  await testArcadeTgm2pStreamingRollbackBudget();
  await testChromePinggy250msNetemSmoothness();
}

main().catch((err) => {
  console.error('\n[FAIL] Real-Life Smoothness Gate Failed:', err);
  process.exit(1);
});
