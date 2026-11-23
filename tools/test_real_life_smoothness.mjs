// Real-Life 240ms Pinggy Netem Chromium E2E (NES 0f + Arcade 0f Shadow)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCoopServer } from '../server/relay_server.mjs';
import {
  sleep, findChromiumBinary, createCdpTab, waitFor, launchHeadlessBrowser
} from './browser_cdp_harness.mjs';
import { startNetemProxy } from './netem_proxy.mjs';
import { resolveSaveSlotPath } from './tetris_scenarios.mjs';
import {
  createDualControllerTestRom, buildFileUploadJs
} from './test_rom_builder_tables.mjs';
import { createMinimalArcadeTestZip } from '../src/fbneo_arcade_core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

async function loadSaveIntoTab1(tab1, tab2, crc, fallbackCrcs = []) {
  if (crc === null) return;
  const srcPath = resolveSaveSlotPath(ROOT_DIR, crc, 1, fallbackCrcs);
  if (!srcPath) return;
  const raw = fs.readFileSync(srcPath, 'utf8');
  const saveFrame = JSON.parse(raw)?.syncState?.frame || 100;
  await tab1.evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(raw)}], 'slot1.sav.json', {
      type: 'application/json'
    }));
    const inp = document.getElementById('saveFileInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  await waitFor(() => Promise.all([
    tab1.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`),
    tab2.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`)
  ]).then(([f1, f2]) =>
    (f1 >= saveFrame && f2 >= saveFrame ? { f1, f2 } : null)
  ), 15000, `Both tabs synced save frame >= ${saveFrame}`);
  const f1Init = await tab1.evaluate(
    `Number(document.getElementById('dbgFrame')?.textContent)`
  );
  await waitFor(() => tab1.evaluate(
    `Number(document.getElementById('dbgFrame')?.textContent) >= ${f1Init + 10}`
  ), 10000, 'Tab 1 advancing frames after save sync');
}

function buildProbeStartJs(keysSeq, intervalMs) {
  return `(() => {
    window.__rafDeltas = [];
    window.__audioBase = typeof window.__nesAudioStats === 'function'
      ? window.__nesAudioStats() : { underruns: 0, overflows: 0 };
    let prev = performance.now();
    window.__probeRun = true;
    function tick(now) {
      if (!window.__probeRun) return;
      window.__rafDeltas.push(now - prev);
      prev = now;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    const seq = ${JSON.stringify(keysSeq)};
    let step = 0, held = null;
    window.__keyTimer = setInterval(() => {
      if (held) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: held }));
        held = null;
      }
      const next = seq[step++ % seq.length];
      if (next) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: next }));
        held = next;
      }
    }, ${intervalMs});
  })()`;
}

const STOP_PROBE_JS = `(() => {
  window.__probeRun = false;
  clearInterval(window.__keyTimer);
  const keys = [
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyZ', 'KeyX'
  ];
  for (const c of keys) {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: c }));
  }
  const d = window.__rafDeltas.slice(5).sort((a, b) => a - b);
  const p95 = d[Math.floor(d.length * 0.95)] || 0;
  const maxRaf = d[d.length - 1] || 0;
  const freezes = d.filter((x) => x > 50).length;
  const cur = typeof window.__nesAudioStats === 'function'
    ? window.__nesAudioStats() : { underruns: 0, overflows: 0 };
  const base = window.__audioBase || { underruns: 0, overflows: 0 };
  const audio = {
    underruns: Math.max(0, (cur.underruns || 0) - (base.underruns || 0)),
    overflows: Math.max(0, (cur.overflows || 0) - (base.overflows || 0))
  };
  const shadow = typeof window.__shadowStats === 'function'
    ? window.__shadowStats() : null;
  const vTxt = document.getElementById('dbgVerifiedFrame')?.textContent || '';
  return {
    p95: Math.round(p95), maxRaf: Math.round(maxRaf), rafCount: d.length,
    freezes, audio, shadow,
    verifiedFrame: Number(vTxt.replace(/[^0-9]/g, '') || 0),
    stepText: document.getElementById('dbgStepTime')?.textContent || '',
    ping: document.getElementById('pingBadge')?.textContent || '',
    desyncs: document.getElementById('dbgDesyncs')?.textContent || '0',
    frame: Number(document.getElementById('dbgFrame')?.textContent || 0)
  };
})()`;

async function selectRomAndStart(tab1, tab2, needle, label, fallback = null) {
  let picked = await tab1.evaluate(`(() => {
    const sel = document.getElementById('localRomSelect');
    const opts = [...sel.options].map((o) => o.value).filter(Boolean);
    const pick = opts.find((v) => v.toLowerCase().includes('${needle}'));
    if (!pick) return '';
    sel.value = pick;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return pick;
  })()`);
  let matchSub = needle.toLowerCase();
  if (!picked && fallback) {
    picked = fallback.name;
    matchSub = fallback.match;
    await tab1.evaluate(buildFileUploadJs(fallback.u8, fallback.name));
  }
  assert.ok(picked, `ROM matching "${needle}" not found in /api/local-roms`);
  await waitFor(() => tab1.evaluate(
    `document.getElementById('romBadge')?.textContent.toLowerCase()` +
      `.includes('${matchSub}')`
  ), 30000, `Host loaded ${label}`);
  const crc = await tab1.evaluate(`(() => {
    const m = /\\[([0-9A-F]+)\\]/i.exec(
      document.getElementById('romBadge')?.textContent || ''
    );
    return m ? m[1].toUpperCase() : '';
  })()`);
  await tab1.evaluate(`document.getElementById('topSendRomBtn').click(); true`);
  await waitFor(() => Promise.all([
    tab2.evaluate(
      `document.getElementById('romBadge')?.textContent.toLowerCase()` +
        `.includes('${matchSub}')`
    ),
    tab1.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`),
    tab2.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`)
  ]).then(([ok, f1, f2]) => (ok && f1 >= 25 && f2 >= 25 ? true : null)),
  35000, `${label} lockstep started on both tabs`);
  return fallback && matchSub === fallback.match ? null : crc;
}

async function runNetemChromeSuite() {
  const bin = findChromiumBinary();
  if (!bin) return console.log('[SKIP] No local Chrome/Edge binary found.');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_netem_e2e_'));
  const app = createCoopServer({
    logAccess: false, logsDir: path.join(tmpDir, 'logs'),
    savesDir: path.join(tmpDir, 'saves'), wirePingIntervalMs: 400
  });
  const hostPort = await app.listen(0, '127.0.0.1');
  const proxy = await startNetemProxy(hostPort, { rttMs: 0 });
  let browser = null;
  try {
    browser = await launchHeadlessBrowser(bin, path.join(tmpDir, 'profile'));
    const tab1 = await createCdpTab(
      browser.debugPort,
      `http://127.0.0.1:${hostPort}/?room=NETEM&nick=HostP1&debug=1`
    );
    const tab2 = await createCdpTab(
      browser.debugPort,
      `http://127.0.0.2:${proxy.port}/?room=NETEM&nick=GuestP2&debug=1`
    );
    await waitFor(() => tab1.evaluate(
      `document.getElementById('lobbyP2Name')?.textContent.includes('GuestP2')`
    ), 10000, 'Both tabs joined NETEM');

    // Force WSS Relay (matching filtered networks where UDP P2P is blocked)
    const forceWss = `(() => {
      const m = document.getElementById('transportModeSelect');
      if (m) m.value = 'wss';
    })()`;
    await Promise.all([tab1.evaluate(forceWss), tab2.evaluate(forceWss)]);

    // 1. NES @ 0f Delay over 240ms Pinggy Netem + OC Sync
    const btCrc = await selectRomAndStart(tab1, tab2, 'battletoads', 'NES', {
      name: 'syn_nes.nes', match: 'syn_nes',
      u8: createDualControllerTestRom(0).uint8
    });
    await loadSaveIntoTab1(tab1, tab2, btCrc, ['53B02F3D']);
    const setDelay0 = `(() => {
      const s = document.getElementById('topInputDelaySelect');
      if (s) { s.value = '0'; s.dispatchEvent(new Event('change')); }
    })()`;
    await Promise.all([tab1.evaluate(setDelay0), tab2.evaluate(setDelay0)]);

    proxy.resetStats();
    proxy.setProfile({
      rttMs: 240, jitterMs: 20, kbpsCap: 170,
      clumpEveryMs: 1400, clumpHoldMs: 120
    });
    const f1StartNes = await tab1.evaluate(
      `Number(document.getElementById('dbgFrame')?.textContent || 0)`
    );
    const nesKeys = ['ArrowRight', 'KeyZ', 'ArrowLeft', 'KeyX', null];
    await Promise.all([
      tab1.evaluate(buildProbeStartJs(nesKeys, 160)),
      tab2.evaluate(buildProbeStartJs(nesKeys.slice().reverse(), 180))
    ]);
    await sleep(3200);
    const [m1, m2] = await Promise.all([
      tab1.evaluate(STOP_PROBE_JS), tab2.evaluate(STOP_PROBE_JS)
    ]);
    const st1 = proxy.getStats();
    const kb1 = Math.round((st1.bytesUp + st1.bytesDown) / 3.2 / 1024);
    const ping1 = Number((/\d+/.exec(m1.ping) || [0])[0]);

    assert.strictEqual(m1.desyncs, '0', 'NES 0f P1 desynced on 240ms netem');
    assert.strictEqual(m2.desyncs, '0', 'NES 0f P2 desynced on 240ms netem');
    assert.ok(
      m1.frame - f1StartNes >= 120 && m2.frame - f1StartNes >= 120,
      `NES 0f stalled: dF=${m1.frame - f1StartNes}/${m2.frame - f1StartNes}`
    );
    assert.ok(kb1 <= 65, `NES wire traffic bloated (${kb1} KB/s > 65)`);
    assert.ok(ping1 >= 180 && ping1 <= 330, `Ping out of bounds: ${m1.ping}`);
    assert.ok(m1.freezes <= 3, `NES 0f Tab 1 had ${m1.freezes} >50ms freezes`);
    assert.strictEqual(m1.audio.underruns, 0, 'NES 0f Audio underrun!');

    // Verify OC: ON default & P1 -> P2 live sync (ON -> MAX -> OFF) over 240ms
    const getOc = `document.getElementById('overclockToggleBtn')?.textContent`;
    const clkOc = `document.getElementById('overclockToggleBtn').click()`;
    assert.strictEqual((await tab1.evaluate(getOc)).trim(), 'OC: ON');
    assert.strictEqual((await tab2.evaluate(getOc)).trim(), 'OC: ON');
    await tab1.evaluate(clkOc);
    await waitFor(() => tab2.evaluate(
      `${getOc}.trim() === 'OC: MAX'`
    ), 12000, 'P2 synced OC: MAX over 240ms netem');
    await tab1.evaluate(clkOc);
    await waitFor(() => tab2.evaluate(
      `${getOc}.trim() === 'OC: OFF'`
    ), 12000, 'P2 synced OC: OFF over 240ms netem');
    assert.strictEqual(
      await tab1.evaluate(`document.getElementById('dbgDesyncs')?.textContent`),
      '0', 'OC toggle caused desync'
    );
    console.log(
      `[PASS] 1/2 Real Chrome 240ms NES Stage1 (0f Delay): ${m1.ping}, ` +
        `Wire=${kb1}KB/s, Step=${m1.stepText}, Freezes=${m1.freezes}, ` +
        `AudioU=${m1.audio.underruns}, OC-Sync OK, 0 Desyncs`
    );

    // 2. Live Arcade (tgm2p.zip or synthetic) at 0f Delay over 240ms Netem
    proxy.setProfile({ rttMs: 0, jitterMs: 0, kbpsCap: 0, clumpEveryMs: 0 });
    const tgmCrc = await selectRomAndStart(tab1, tab2, 'tgm2p', 'Arcade', {
      name: 'minivadr.zip', match: 'minivadr',
      u8: createMinimalArcadeTestZip()
    });
    await loadSaveIntoTab1(tab1, tab2, tgmCrc, ['2AAB0722']);
    await Promise.all([tab1.evaluate(setDelay0), tab2.evaluate(setDelay0)]);
    await tab1.send('Page.bringToFront');
    await sleep(400);

    proxy.resetStats();
    proxy.setProfile({
      rttMs: 240, jitterMs: 20, kbpsCap: 170,
      clumpEveryMs: 1200, clumpHoldMs: 120
    });
    const f1StartTgm = await tab1.evaluate(
      `Number(document.getElementById('dbgFrame')?.textContent || 0)`
    );
    const tgmP1 = ['ArrowLeft', null, 'KeyZ', 'KeyZ', 'ArrowDown'];
    const tgmP2 = ['ArrowRight', 'KeyX', null, 'KeyX', 'ArrowDown'];
    await Promise.all([
      tab1.evaluate(buildProbeStartJs(tgmP1, 120)),
      tab2.evaluate(buildProbeStartJs(tgmP2, 110))
    ]);
    await sleep(3600);
    const [t1, t2] = await Promise.all([
      tab1.evaluate(STOP_PROBE_JS), tab2.evaluate(STOP_PROBE_JS)
    ]);
    const st2 = proxy.getStats();
    const kb2 = Math.round((st2.bytesUp + st2.bytesDown) / 3.6 / 1024);

    assert.strictEqual(t1.desyncs, '0', 'Tetris 0f P1 desynced on 240ms');
    assert.strictEqual(t2.desyncs, '0', 'Tetris 0f P2 desynced on 240ms');
    assert.ok(
      t1.frame - f1StartTgm >= 140 && t2.frame - f1StartTgm >= 140,
      `Tetris 0f stalled: dF=${t1.frame - f1StartTgm}/${t2.frame - f1StartTgm}`
    );
    assert.ok(kb2 <= 65, `Tetris wire traffic bloated (${kb2} KB/s > 65)`);
    assert.ok(
      t1.rafCount >= 100,
      `Expected foreground rAF samples >= 100, got ${t1.rafCount}`
    );
    assert.ok(
      t1.p95 <= 24,
      `Tetris 0f main-thread rAF p95=${t1.p95}ms (>24ms, max=${t1.maxRaf}ms)`
    );
    assert.strictEqual(
      t1.freezes, 0,
      `Tetris 0f had ${t1.freezes} >50ms freezes (maxRaf=${t1.maxRaf}ms)`
    );
    assert.strictEqual(t1.audio.underruns, 0, 'Tetris 0f Audio underrun!');
    assert.strictEqual(t1.audio.overflows, 0, 'Tetris 0f Audio overflow!');
    assert.ok(
      t1.shadow?.ready && !t1.shadow.failed && t1.shadow.shadowSwaps > 0,
      `Tab 1 Shadow Worker inactive: ${JSON.stringify(t1.shadow)}`
    );
    assert.ok(
      t2.shadow?.ready && !t2.shadow.failed && t2.shadow.shadowSwaps > 0,
      `Tab 2 Shadow Worker inactive: ${JSON.stringify(t2.shadow)}`
    );
    assert.ok(
      t1.verifiedFrame > f1StartTgm && t2.verifiedFrame > f1StartTgm,
      `Confirmed 30f hashes did not verify: ` +
        `v1=${t1.verifiedFrame} v2=${t2.verifiedFrame} start=${f1StartTgm}`
    );
    assert.strictEqual(tab1.exceptions.length, 0, tab1.exceptions.join('; '));
    assert.strictEqual(tab2.exceptions.length, 0, tab2.exceptions.join('; '));
    console.log(
      `[PASS] 2/2 Real Chrome 240ms Live 2P Tetris (0f Delay): ${t1.ping}, ` +
        `Wire=${kb2}KB/s, rAF p95=${t1.p95}ms max=${t1.maxRaf}ms, ` +
        `ShadowSwaps=${t1.shadow.shadowSwaps} (gap=${t1.shadow.avgGap}f), ` +
        `Verified=#${t1.verifiedFrame}, AudioU/O=${t1.audio.underruns}/` +
        `${t1.audio.overflows}, 0 Desyncs`
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
  console.log('=== Real-Life 240ms Pinggy Netem Chromium Smoothness ===\n');
  await runNetemChromeSuite();
}

main().catch((err) => {
  console.error('\n[FAIL] Real-Life Smoothness Gate Failed:', err);
  process.exit(1);
});
