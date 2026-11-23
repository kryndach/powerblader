// Real Chrome 2-Tab E2E: SNES, Sega Mega Drive & Mid-Match F5 Browser Reload
import assert from 'assert';
import { sleep, createCdpTab, waitFor } from './browser_cdp_harness.mjs';
import {
  createDualControllerTestRom, buildFileUploadJs
} from './test_rom_builder_tables.mjs';

async function selectLocalRomAndSync(tab1, tab2, prefix, label) {
  const picked = await tab1.evaluate(`(() => {
    const sel = document.getElementById('localRomSelect');
    const opts = [...sel.options].map((o) => o.value).filter(Boolean);
    const pick = opts.find((v) => v.toLowerCase().startsWith('${prefix}'));
    if (!pick) return '';
    sel.value = pick;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return pick;
  })()`);
  if (!picked) return null;

  await waitFor(() => tab1.evaluate(`(() => {
    const log = document.getElementById('dbgLog')?.textContent || '';
    if (log.includes('Failed to load')) throw new Error(log.slice(0, 220));
    const b = document.getElementById('romBadge')?.textContent || '';
    return b.includes('[') && !b.includes('None') ? b : null;
  })()`), 25000, `${label} load on Tab 1`);

  await tab1.evaluate(`document.getElementById('topSendRomBtn').click(); true`);
  await waitFor(() => Promise.all([
    tab1.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`),
    tab2.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`)
  ]).then(([f1, f2]) => (f1 >= 35 && f2 >= 35 ? { f1, f2 } : null)),
  30000, `${label} 2-tab lockstep >= 35`);

  const pressJs = (code) => `(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}' }));
    setTimeout(() => window.dispatchEvent(
      new KeyboardEvent('keyup', { code: '${code}' })
    ), 160);
    return true;
  })()`;
  await Promise.all([
    tab1.evaluate(pressJs('ArrowRight')),
    tab2.evaluate(pressJs('ArrowLeft'))
  ]);
  await sleep(350);

  const [d1, d2] = await Promise.all([
    tab1.evaluate(`document.getElementById('dbgDesyncs')?.textContent || '0'`),
    tab2.evaluate(`document.getElementById('dbgDesyncs')?.textContent || '0'`)
  ]);
  assert.strictEqual(d1, '0', `${label} P1 desynced`);
  assert.strictEqual(d2, '0', `${label} P2 desynced`);
  return picked;
}

export async function runMultiConsoleAndReloadE2E(browser, hostPort, remPort) {
  const tab1 = await createCdpTab(
    browser.debugPort,
    `http://127.0.0.1:${hostPort}/?room=MC2P&nick=HostP1&debug=1`
  );
  const tab2 = await createCdpTab(
    browser.debugPort,
    `http://127.0.0.2:${remPort}/?room=MC2P&nick=GuestP2&debug=1`
  );
  try {
    await waitFor(() => tab1.evaluate(
      `document.getElementById('lobbyP2Name')?.textContent.includes('GuestP2')`
    ), 12000, 'Both tabs joined MC2P');

    const snesRom = await selectLocalRomAndSync(tab1, tab2, 'snes/', 'SNES');
    const segaRom = await selectLocalRomAndSync(tab1, tab2, 'sega/', 'Sega MD');
    if (!snesRom && !segaRom) {
      await tab1.evaluate(
        buildFileUploadJs(createDualControllerTestRom(0).uint8, 'syn_f5.nes')
      );
      await waitFor(() => tab1.evaluate(
        `document.getElementById('romBadge')?.textContent.includes('syn_f5')`
      ), 10000, 'Synthetic F5 reload ROM loaded');
      await tab1.evaluate(`document.getElementById('topSendRomBtn').click()`);
      await waitFor(() => tab2.evaluate(
        `Number(document.getElementById('dbgFrame')?.textContent) >= 25`
      ), 15000, 'Synthetic pre-F5 lockstep >= 25');
    }

    // Real Browser F5 Reload on Tab 2 mid-match -> auto-rejoin & resync!
    await tab2.evaluate(`window.location.reload(); true`);
    await sleep(600);
    await waitFor(() => tab2.evaluate(
      `document.getElementById('dbgWssState')?.textContent === 'Connected'`
    ), 12000, 'Tab 2 reconnected after real F5 reload');
    await waitFor(() => tab1.evaluate(
      `document.getElementById('lobbyP2Name')?.textContent.includes('GuestP2')`
    ), 10000, 'Host saw Tab 2 rejoin after F5');

    await tab1.evaluate(
      `document.getElementById('topSendRomBtn').click(); true`
    );
    await waitFor(() => Promise.all([
      tab1.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`),
      tab2.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`)
    ]).then(([f1, f2]) => (f1 >= 30 && f2 >= 30 ? { f1, f2 } : null)),
    25000, 'Post-F5 resync & lockstep >= 30');

    const getDesync = `document.getElementById('dbgDesyncs')?.textContent||'0'`;
    const [d1, d2] = await Promise.all([
      tab1.evaluate(getDesync), tab2.evaluate(getDesync)
    ]);
    assert.strictEqual(d1, '0', 'P1 desynced after Tab 2 F5 reload');
    assert.strictEqual(d2, '0', 'P2 desynced after Tab 2 F5 reload');
    assert.strictEqual(tab1.exceptions.length, 0, tab1.exceptions.join('; '));
    assert.strictEqual(tab2.exceptions.length, 0, tab2.exceptions.join('; '));
    console.log(
      `[PASS] 2/4 Real Chrome Multi-Console (SNES=${snesRom || 'N/A'}, ` +
        `Sega=${segaRom || 'N/A'}) + Mid-Match F5 Reload Recovery (0 Desyncs)`
    );
  } finally {
    try { tab1.close(); } catch {}
    try { tab2.close(); } catch {}
  }
}
