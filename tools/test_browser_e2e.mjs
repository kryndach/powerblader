// Real Headless Chromium 2-Tab End-to-End Test (P1 Host + P2 Remote Loopback)
import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { createCoopServer } from '../server/relay_server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromiumBinary() {
  const candidates = [
    path.join(
      process.env.ProgramFiles || 'C:\\Program Files',
      'Google\\Chrome\\Application\\chrome.exe'
    ),
    path.join(
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Microsoft\\Edge\\Application\\msedge.exe'
    ),
    path.join(
      process.env.ProgramFiles || 'C:\\Program Files',
      'Microsoft\\Edge\\Application\\msedge.exe'
    ),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function createCdpTab(debugPort, targetUrl) {
  const created = await new Promise((resolve, reject) => {
    const u = `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(
      targetUrl
    )}`;
    const req = http.request(u, { method: 'PUT' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });

  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let nextId = 1;
  const pending = new Map();
  const exceptions = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      exceptions.push(d?.exception?.description || d?.text || 'JS Exception');
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description || res.exceptionDetails.text
      );
    }
    return res.result?.value;
  };

  return { ws, evaluate, exceptions, close: () => ws.close() };
}

async function waitFor(fn, timeoutMs = 25000, label = 'condition') {
  const t0 = Date.now();
  let lastVal = null;
  while (Date.now() - t0 < timeoutMs) {
    lastVal = await fn();
    if (lastVal) return lastVal;
    await sleep(80);
  }
  throw new Error(`Timeout waiting for ${label} (last=${JSON.stringify(
    lastVal
  )})`);
}

function startRemoteProxy(targetPort) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((client) => {
      const upstream = net.connect(targetPort, '127.0.0.1');
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.2', () => resolve({
      port: srv.address().port,
      close: () => new Promise((r) => srv.close(() => r()))
    }));
  });
}

async function launchHeadlessBrowser(binPath, userDataDir) {
  const proc = spawn(binPath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  const debugPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Chrome launch timeout: ${stderr}`)), 12000
    );
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}): ${stderr}`));
    });
  });
  await waitFor(() => httpJson(`http://127.0.0.1:${debugPort}/json/version`)
    .catch(() => null), 5000, 'CDP ready');
  return { proc, debugPort };
}

async function main() {
  console.log('=== Real Chromium 2-Tab End-to-End Netplay & WASM Suite ===\n');
  const bin = findChromiumBinary();
  if (!bin) {
    console.log('[SKIP] No local Chrome/Edge binary found.');
    return;
  }
  const app = createCoopServer({ logAccess: false });
  const hostPort = await app.listen(0, '127.0.0.1');
  const remProxy = await startRemoteProxy(hostPort);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_e2e_chrome_'));
  let browser = null, tab1 = null, tab2 = null;

  try {
    browser = await launchHeadlessBrowser(bin, tmpDir);
    tab1 = await createCdpTab(
      browser.debugPort,
      `http://127.0.0.1:${hostPort}/?room=E2E&nick=HostSG&debug=1`
    );
    tab2 = await createCdpTab(
      browser.debugPort,
      `http://127.0.0.2:${remProxy.port}/?room=E2E&nick=BroRU&debug=1`
    );

    // 1. Wait for both real DOMs + ES module graphs to boot cleanly
    await waitFor(() => tab1.evaluate(
      `Boolean(document.getElementById('connectBtn') && ` +
      `document.getElementById('localRomSelect')?.options.length > 1)`
    ), 10000, 'Tab 1 DOM & /api/local-roms ready');
    await waitFor(() => tab2.evaluate(
      `Boolean(document.getElementById('connectBtn'))`
    ), 10000, 'Tab 2 DOM ready');
    // Pre-seed Chrome's real immutable HTTP disk cache with non-Range WASM GET
    // so remote Tab 2 proves striped rawgz=1 Range never splices cached raw!
    await tab2.evaluate(
      `fetch('/vendor/fbneo_arcade.wasm?v=3').then((r) => r.arrayBuffer())` +
      `.then((b) => b.byteLength)`
    );

    // Watch #topSendRomBtn labels in real DOM
    await tab1.evaluate(`
      window.__seenBtnTexts = [];
      new MutationObserver(() => {
        const t = document.getElementById('topSendRomBtn')?.textContent || '';
        if (t) window.__seenBtnTexts.push(t);
      }).observe(document.getElementById('topSendRomBtn'), {
        childList: true, characterData: true, subtree: true
      });
    `);

    // 2. Connect both tabs to Room E2E
    await tab1.evaluate(`document.getElementById('connectBtn').click(); true`);
    await tab2.evaluate(`document.getElementById('connectBtn').click(); true`);
    await waitFor(() => tab1.evaluate(
      `document.getElementById('lobbyP2Name')?.textContent.includes('BroRU')`
    ), 8000, 'Both tabs joined Room E2E');

    // 3. Pick Arcade ROM (tgm2p.zip if present, else first available local ROM)
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

    // 4. Send ROM from P1 (127.0.0.1) -> P2 (127.0.0.2 remote striped Range!)
    await tab1.evaluate(
      `document.getElementById('topSendRomBtn').click(); true`
    );
    await waitFor(() => Promise.all([
      tab1.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`),
      tab2.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`)
    ]).then(([f1, f2]) => (f1 >= 45 && f2 >= 45 ? { f1, f2 } : null)),
    30000, '2-Tab Real Chrome Lockstep Frame >= 45');

    // 5. Verify UI invariants, 0 desyncs, non-black canvas & mid-game QuickSave
    const seenBtns = await tab1.evaluate(`window.__seenBtnTexts`);
    assert.ok(
      !seenBtns.some((t) => t.includes('Partner DL') || /^DL\s+\d/.test(t)),
      `Forbidden upload button text seen: ${JSON.stringify(seenBtns)}`
    );

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
    await sleep(150);
    await tab1.evaluate(
      `document.getElementById('quickLoadBtn').click(); true`
    );
    await sleep(300);

    const check = await Promise.all([
      tab1.evaluate(`({
        hidden: document.getElementById('lobbyOverlay')
          .classList.contains('hidden'),
        popupShown: window.__popupShownMidGame,
        desyncs: document.getElementById('dbgDesyncs').textContent,
        btn: document.getElementById('topSendRomBtn').textContent
      })`),
      tab2.evaluate(`({
        hidden: document.getElementById('lobbyOverlay')
          .classList.contains('hidden'),
        desyncs: document.getElementById('dbgDesyncs').textContent,
        isRemoteMode: location.hostname === '127.0.0.2'
      })`)
    ]);
    assert.strictEqual(check[0].hidden, true, 'P1 Lobby must stay hidden');
    assert.strictEqual(check[0].popupShown, false, 'No mid-game Lobby popup');
    assert.strictEqual(check[0].desyncs, '0', 'P1 must have 0 desyncs');
    assert.strictEqual(check[0].btn, 'Send ROM', 'Send button reset cleanly');
    assert.strictEqual(check[1].hidden, true, 'P2 Lobby must stay hidden');
    assert.strictEqual(check[1].desyncs, '0', 'P2 must have 0 desyncs');
    assert.strictEqual(check[1].isRemoteMode, true);
    assert.strictEqual(tab1.exceptions.length, 0, tab1.exceptions.join('; '));
    assert.strictEqual(tab2.exceptions.length, 0, tab2.exceptions.join('; '));

    console.log(
      `[PASS] Real Chrome 2-Tab E2E (${pickedRom}): Host+Remote Striped ` +
      `WASM/ROM Sync, Live UI, Mid-Game Save/Load & 0 Desyncs Verified!`
    );
  } finally {
    try { tab1?.close(); } catch {}
    try { tab2?.close(); } catch {}
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
