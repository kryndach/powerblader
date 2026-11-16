// Real Headless Chromium 2-Tab E2E Suite (Main Game + Zero-Click /autotest v3)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCoopServer } from '../server/relay_server.mjs';
import {
  sleep, findChromiumBinary, createCdpTab, waitFor, startRemoteProxy,
  launchHeadlessBrowser, buildMultiSliceArcadeZipBase64
} from './browser_cdp_harness.mjs';

async function runMainGameTwoTabE2E(browser, hostPort, remPort) {
  const tab1 = await createCdpTab(
    browser.debugPort,
    `http://127.0.0.1:${hostPort}/?room=E2E&nick=HostSG&debug=1`
  );
  const tab2 = await createCdpTab(
    browser.debugPort,
    `http://127.0.0.2:${remPort}/?room=E2E&nick=BroRU&debug=1`
  );
  try {
    await waitFor(() => tab1.evaluate(
      `Boolean(document.getElementById('connectBtn') && ` +
      `document.getElementById('localRomSelect')?.options.length > 1)`
    ), 10000, 'Tab 1 DOM & /api/local-roms ready');
    await waitFor(() => tab2.evaluate(
      `Boolean(document.getElementById('connectBtn'))`
    ), 10000, 'Tab 2 DOM ready');

    await tab2.evaluate(
      `fetch('/vendor/fbneo_arcade.wasm?v=3').then((r) => r.arrayBuffer())` +
      `.then((b) => b.byteLength)`
    );

    const observeBtns = `
      window.__seenBtnTexts = [];
      new MutationObserver(() => {
        const t = document.getElementById('topSendRomBtn')?.textContent || '';
        if (t) window.__seenBtnTexts.push(t);
      }).observe(document.getElementById('topSendRomBtn'), {
        childList: true, characterData: true, subtree: true
      });
    `;
    await tab1.evaluate(observeBtns);
    await tab2.evaluate(observeBtns);

    await tab1.evaluate(`document.getElementById('connectBtn').click(); true`);
    await tab2.evaluate(`document.getElementById('connectBtn').click(); true`);
    await waitFor(() => tab1.evaluate(
      `document.getElementById('lobbyP2Name')?.textContent.includes('BroRU')`
    ), 8000, 'Both tabs joined Room E2E');

    const pickedRom = await tab1.evaluate(`(() => {
      const sel = document.getElementById('localRomSelect');
      const opts = [...sel.options].map((o) => o.value).filter(Boolean);
      const pick = opts.find((v) => v.includes('tgm2p')) || opts[0];
      sel.value = pick;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return pick;
    })()`);

    await waitFor(() => tab1.evaluate(`(() => {
      const log = document.getElementById('dbgLog')?.textContent || '';
      if (log.includes('Failed to load')) throw new Error(log.slice(0, 220));
      const b = document.getElementById('romBadge')?.textContent || '';
      return b.includes('[') && !b.includes('None') ? b : null;
    })()`), 25000, `Tab 1 load ${pickedRom}`);

    await tab1.evaluate(
      `document.getElementById('topSendRomBtn').click(); true`
    );
    await waitFor(() => Promise.all([
      tab1.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`),
      tab2.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`)
    ]).then(([f1, f2]) => (f1 >= 45 && f2 >= 45 ? { f1, f2 } : null)),
    30000, '2-Tab Real Chrome Lockstep Frame >= 45');

    const seenBtns1 = await tab1.evaluate(`window.__seenBtnTexts`);
    assert.ok(
      !seenBtns1.some((t) => t.includes('Partner DL') || /^DL\s+\d/.test(t)),
      `Forbidden upload button text seen: ${JSON.stringify(seenBtns1)}`
    );

    // Mid-game QuickSave / QuickLoad + Turbo 1x -> 4x -> 1x sync check
    await tab1.evaluate(`
      window.__popupShownMidGame = false;
      new MutationObserver(() => {
        const ov = document.getElementById('lobbyOverlay');
        if (ov && !ov.classList.contains('hidden')) {
          window.__popupShownMidGame = true;
        }
      }).observe(document.getElementById('lobbyOverlay'), {
        attributes: true, attributeFilter: ['class']
      });
      document.getElementById('quickSaveBtn').click();
      true;
    `);
    await sleep(120);
    await tab1.evaluate(
      `document.getElementById('quickLoadBtn').click(); true`
    );
    await tab1.evaluate(
      `document.querySelector('.speed-btn[data-speed="4"]').click(); true`
    );
    await waitFor(() => tab2.evaluate(
      `document.querySelector('.speed-btn[data-speed="4"]')` +
      `?.classList.contains('active-toggle')`
    ), 5000, 'Tab 2 synced 4x Turbo');
    const preTurboF = await tab1.evaluate(
      `Number(document.getElementById('dbgFrame')?.textContent)`
    );
    await waitFor(() => tab1.evaluate(
      `Number(document.getElementById('dbgFrame')?.textContent)`
    ).then((f) => (f >= preTurboF + 40 ? f : null)), 8000, '4x Turbo frames');
    await tab1.evaluate(
      `document.querySelector('.speed-btn[data-speed="1"]').click(); true`
    );
    await waitFor(() => tab2.evaluate(
      `document.querySelector('.speed-btn[data-speed="1"]')` +
      `?.classList.contains('active-toggle')`
    ), 5000, 'Tab 2 restored 1x speed');

    const midCheck = await tab1.evaluate(`({
      popupShown: window.__popupShownMidGame,
      desyncs: document.getElementById('dbgDesyncs').textContent
    })`);
    assert.strictEqual(midCheck.popupShown, false, 'No mid-game Lobby popup');
    assert.strictEqual(midCheck.desyncs, '0', '0 desyncs after Save/4x Turbo');

    // Remote P2 (127.0.0.2) -> P1 (127.0.0.1) custom 300KB .zip multipart sync
    const zipB64 = buildMultiSliceArcadeZipBase64(290000);
    await tab2.evaluate(`(() => {
      window.__seenBtnTexts = [];
      const bin = atob(${JSON.stringify(zipB64)});
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([u8], 'minivadr_p2.zip', {
        type: 'application/zip'
      }));
      const inp = document.getElementById('romFileInput');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return u8.byteLength;
    })()`);
    await waitFor(() => tab2.evaluate(`
      document.getElementById('romBadge')?.textContent.includes('minivadr_p2')
    `), 15000, 'Remote Tab 2 loaded custom minivadr_p2.zip locally');
    await tab2.evaluate(
      `document.getElementById('topSendRomBtn').click(); true`
    );
    await waitFor(() => Promise.all([
      tab1.evaluate(`({
        rom: document.getElementById('romBadge')?.textContent || '',
        f: Number(document.getElementById('dbgFrame')?.textContent)
      })`),
      tab2.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`)
    ]).then(([p1, f2]) =>
      p1.rom.includes('minivadr_p2') && p1.f >= 30 && f2 >= 30 ? p1 : null
    ), 20000, 'P2 -> P1 multipart .zip upload & lockstep >= 30');

    const p2Check = await Promise.all([
      tab1.evaluate(`document.getElementById('dbgDesyncs').textContent`),
      tab2.evaluate(`({
        desyncs: document.getElementById('dbgDesyncs').textContent,
        btns: window.__seenBtnTexts
      })`)
    ]);
    assert.strictEqual(p2Check[0], '0', 'P1 0 desyncs after P2->P1 zip');
    assert.strictEqual(p2Check[1].desyncs, '0', 'P2 0 desyncs');
    assert.ok(
      p2Check[1].btns.some((t) => t.startsWith('Uploading ')),
      `Expected Uploading % on Remote P2 button: ${JSON.stringify(
        p2Check[1].btns
      )}`
    );
    assert.strictEqual(tab1.exceptions.length, 0, tab1.exceptions.join('; '));
    assert.strictEqual(tab2.exceptions.length, 0, tab2.exceptions.join('; '));
    console.log(
      `[PASS] 1/3 Real Chrome Main Game E2E (${pickedRom} + 4x Turbo + ` +
      `P2->P1 Multipart .zip + Save/Load + 0 Desyncs)`
    );
  } finally {
    try { tab1.close(); } catch {}
    try { tab2.close(); } catch {}
  }
}

async function runAutotestV3TwoTabE2E(browser, hostPort, remPort, logsDir) {
  const q = 'room=E2EAUTO&gameRoom=POSTAT';
  const tabA = await createCdpTab(
    browser.debugPort, `http://127.0.0.1:${hostPort}/autotest?${q}`
  );
  const tabB = await createCdpTab(
    browser.debugPort, `http://127.0.0.2:${remPort}/autotest?${q}`
  );
  try {
    const hdr = await waitFor(() => tabA.evaluate(
      `document.body?.textContent.includes('AUTOBENCH v3.0')`
    ), 8000, 'AUTOBENCH v3.0 header');
    assert.strictEqual(hdr, true);

    await waitFor(async () => {
      if (tabA.exceptions.length) throw new Error(tabA.exceptions.join('; '));
      if (tabB.exceptions.length) throw new Error(tabB.exceptions.join('; '));
      const [a, b] = await Promise.all([
        tabA.evaluate(`document.getElementById('stateBadge')?.textContent`),
        tabB.evaluate(`document.getElementById('stateBadge')?.textContent`)
      ]);
      return a === 'BENCHMARK COMPLETE' && b === 'BENCHMARK COMPLETE'
        ? true : null;
    }, 55000, 'Zero-click /autotest v3.0 completion on both tabs');

    const domRes = await Promise.all([
      tabA.evaluate(`document.querySelectorAll('#stagesBody tr').length`),
      tabB.evaluate(`document.querySelectorAll('#stagesBody tr').length`)
    ]);
    assert.strictEqual(domRes[0], 8, 'Tab A must render 8 benchmark stages');
    assert.strictEqual(domRes[1], 8, 'Tab B must render 8 benchmark stages');

    const jsonPath = path.join(logsDir, 'autotest_latest.json');
    const txtPath = path.join(logsDir, 'autotest_latest.txt');
    assert.ok(fs.existsSync(jsonPath) && fs.existsSync(txtPath));
    const session = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const txt = fs.readFileSync(txtPath, 'utf8');

    assert.strictEqual(session.pc1?.overallStatus, 'COMPLETE');
    assert.strictEqual(session.pc2?.overallStatus, 'COMPLETE');
    assert.strictEqual(session.pc1?.stages?.length, 8);
    assert.ok(!session.pc1.stages.some((s) => s.status === 'FAIL'));
    assert.strictEqual(session.pc1?.dualWsOk, true);
    assert.strictEqual(session.pc2?.dualWsOk, true);
    assert.strictEqual(session.pc1?.httpBench?.crcOk, true);
    assert.ok(session.pc1?.httpBench?.stripeDlKbps > 0);
    assert.ok(session.pc1?.httpBench?.pc2UploadKbps > 0);
    assert.strictEqual(session.pc1?.wasmBench?.hashMatch, true);
    assert.strictEqual(session.pc1?.liveNetplay?.hashMatch, true);
    assert.strictEqual(session.pc1?.liveNetplay?.pc1Desyncs, 0);
    assert.strictEqual(session.pc1?.liveNetplay?.pc2Desyncs, 0);
    assert.strictEqual(session.pc1?.liveNetplay?.syncImportOk, true);
    assert.ok(txt.includes('AUTO-TUNED NETPLAY RECOMMENDATIONS'));
    assert.strictEqual(tabA.exceptions.length, 0, tabA.exceptions.join('; '));
    assert.strictEqual(tabB.exceptions.length, 0, tabB.exceptions.join('; '));

    // Click "Back to NES Game" on both tabs & verify auto-rejoin to POSTAT!
    await tabA.evaluate(`document.getElementById('backToGameBtn').click()`);
    await tabB.evaluate(`document.getElementById('backToGameBtn').click()`);
    await waitFor(() => tabA.evaluate(`(() => {
      const b = document.getElementById('lobbyRoomBadge')?.textContent || '';
      const p2 = document.getElementById('lobbyP2Badge')?.textContent || '';
      return b.includes('POSTAT') && p2 !== 'WAITING' && p2 !== 'OFFLINE';
    })()`), 10000, 'Post-autotest auto-rejoin Room POSTAT on both tabs');

    console.log(
      '[PASS] 2/3 Real Chrome Zero-Click /autotest v3.0 + Post-Autotest ' +
      'Auto-Rejoin E2E Verified'
    );
  } finally {
    try { tabA.close(); } catch {}
    try { tabB.close(); } catch {}
  }

  const tabNet = await createCdpTab(
    browser.debugPort, `http://127.0.0.1:${hostPort}/nettest?room=E2ENET`
  );
  try {
    await waitFor(async () => {
      if (tabNet.exceptions.length) throw new Error(tabNet.exceptions[0]);
      return tabNet.evaluate(
        `Boolean(document.getElementById('logBox')?.children.length)`
      );
    }, 8000, '/nettest ES module boot');
    assert.strictEqual(tabNet.exceptions.length, 0);
    console.log('[PASS] 3/3 Real Chrome /nettest Workbench Boot Verified');
  } finally {
    try { tabNet.close(); } catch {}
  }
}

async function main() {
  console.log('=== Real Chromium 2-Tab End-to-End Netplay & AutoBench ===\n');
  const bin = findChromiumBinary();
  if (!bin) return console.log('[SKIP] No local Chrome/Edge binary found.');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_e2e_chrome_'));
  const logsDir = path.join(tmpDir, 'logs');
  const app = createCoopServer({ logAccess: false, logsDir });
  const hostPort = await app.listen(0, '127.0.0.1');
  const remProxy = await startRemoteProxy(hostPort);
  let browser = null;
  try {
    browser = await launchHeadlessBrowser(bin, path.join(tmpDir, 'profile'));
    await runMainGameTwoTabE2E(browser, hostPort, remProxy.port);
    await runAutotestV3TwoTabE2E(browser, hostPort, remProxy.port, logsDir);
  } finally {
    if (browser?.proc) {
      try { browser.proc.kill('SIGKILL'); } catch {}
      await sleep(150);
    }
    await remProxy.close();
    await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error('\n[FAIL] Real Chromium E2E Suite Failed:', err);
  process.exit(1);
});
