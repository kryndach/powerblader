// GitHub Pages Hybrid E2E: Sub-Path /NES_Online/, Auth, Auto-Heal & P2P
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket, { WebSocketServer } from 'ws';
import { createCoopServer } from '../server/relay_server.mjs';
import { verifyBip340 } from '../server/nostr_crypto.mjs';
import { deriveRoomAuthToken } from '../src/room_auth.mjs';
import { buildGitHubPagesBundle } from './build_gh_pages.mjs';
import { startNetemProxy } from './netem_proxy.mjs';
import {
  sleep, findChromiumBinary, createCdpTab, waitFor, launchHeadlessBrowser
} from './browser_cdp_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm'
};

async function startSubPathStaticServer(distDir, prefix = '/NES_Online') {
  const missing404s = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (!u.pathname.startsWith(prefix)) {
      missing404s.push(u.pathname);
      res.writeHead(404); return res.end('Not found');
    }
    let rel = u.pathname.slice(prefix.length) || '/';
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.resolve(distDir, `.${rel}`);
    if (!full.startsWith(path.resolve(distDir)) || !fs.existsSync(full)) {
      const isProbe = rel.endsWith('/api/health') ||
        rel.endsWith('/api/tunnel-routes');
      if (!isProbe) missing404s.push(u.pathname);
      res.writeHead(404); return res.end('Not found');
    }
    const ext = path.extname(full).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    fs.createReadStream(full).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    missing404s,
    close: () => new Promise((r) => srv.close(() => r()))
  };
}

async function startLocalNostrRelay() {
  const events = new Map();
  const subs = new Set();
  const srv = http.createServer((_req, res) => {
    res.writeHead(200); res.end();
  });
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg[0] === 'EVENT' && msg[1]) {
          const ev = msg[1];
          const ok = verifyBip340(Buffer.from(ev.id, 'hex'), ev.pubkey, ev.sig);
          ws.send(JSON.stringify(['OK', ev.id, ok, ok ? '' : 'bad sig']));
          if (ok) {
            const dTag = (ev.tags || []).find((t) => t[0] === 'd')?.[1] || '';
            events.set(`${ev.pubkey}:${dTag}`, { ev, dTag });
            for (const s of subs) {
              const hit = !s.dList || s.dList.includes(dTag);
              if (s.ws.readyState === 1 && hit) {
                s.ws.send(JSON.stringify(['EVENT', s.subId, ev]));
              }
            }
          }
        } else if (msg[0] === 'REQ' && msg[1]) {
          const subId = msg[1];
          const dList = Array.isArray(msg[2]?.['#d']) ? msg[2]['#d'] : null;
          subs.add({ ws, subId, dList });
          for (const item of events.values()) {
            if (!dList || dList.includes(item.dTag)) {
              ws.send(JSON.stringify(['EVENT', subId, item.ev]));
            }
          }
          ws.send(JSON.stringify(['EOSE', subId]));
        }
      } catch {}
    });
    ws.on('close', () => {
      for (const s of [...subs]) if (s.ws === ws) subs.delete(s);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    close: () => new Promise((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => srv.close(() => r()));
    })
  };
}

async function runSuite() {
  const bin = findChromiumBinary();
  if (!bin) return console.log('[SKIP] No local Chrome binary found.');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_gh_pages_'));
  const distDir = path.join(tmpDir, 'dist-pages');
  const built = buildGitHubPagesBundle(ROOT_DIR, distDir);
  assert.ok(fs.existsSync(path.join(distDir, '.nojekyll')));
  assert.ok(fs.existsSync(path.join(distDir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(distDir, 'vendor', 'jsnes.js')));
  assert.ok(!fs.existsSync(path.join(distDir, 'local')), 'local/ leaked!');
  console.log(
    `[PASS] 1/4 Built Static GitHub Pages Bundle (${built.totalFiles} files, ` +
      `${built.totalMb} MB, 0 ROMs/secrets)`
  );

  const pagesSrv = await startSubPathStaticServer(distDir, '/NES_Online');
  const nostr = await startLocalNostrRelay();
  const relayUrl = `ws://127.0.0.1:${nostr.port}`;
  let app = null, proxy1 = null, proxy2 = null, browser = null;
  try {
    app = createCoopServer({
      logAccess: false, logsDir: path.join(tmpDir, 'logs'),
      savesDir: path.join(tmpDir, 'saves'),
      secretPath: path.join(tmpDir, 'secret.txt'),
      roomPasswordPath: path.join(tmpDir, 'pass.txt'),
      rendezvousRelays: [relayUrl]
    });
    const hostPort = await app.listen(0, '127.0.0.1');
    proxy1 = await startNetemProxy(hostPort, { rttMs: 12 });
    proxy2 = await startNetemProxy(hostPort, { rttMs: 10 });
    await app.beacon.setRoomPassword('NOVA', 'secret777');
    const goodAuth = await deriveRoomAuthToken('NOVA', 'secret777');

    // Stage 2: Verify Room Password Gate (HTTP 403 + WS auth_required)
    const codeNoAuth = await new Promise((r) => {
      http.get({
        host: '127.0.0.1', port: hostPort, path: '/api/local-roms',
        headers: { Host: 'bro.pinggy-free.link', 'X-Forwarded-For': '91.1.1.1' }
      }, (res) => { res.resume(); r(res.statusCode); });
    });
    assert.strictEqual(codeNoAuth, 403, 'Expected 403 without room auth');
    const codeAuth = await new Promise((r) => {
      http.get({
        host: '127.0.0.1', port: hostPort,
        path: `/api/local-roms?auth=${goodAuth}`,
        headers: { Host: 'bro.pinggy-free.link', 'X-Forwarded-For': '91.1.1.1' }
      }, (res) => { res.resume(); r(res.statusCode); });
    });
    assert.strictEqual(codeAuth, 200, 'Expected 200 with valid room auth');
    const wsErr = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.2:${proxy1.port}/ws`);
      ws.on('open', () => ws.send(JSON.stringify({
        type: 'join_room', roomCode: 'NOVA', nick: 'Eve', roomAuth: 'wrong'
      })));
      ws.on('message', (d) => {
        ws.close(); resolve(JSON.parse(d.toString()));
      });
    });
    assert.strictEqual(wsErr.type, 'auth_required');
    console.log(
      '[PASS] 2/4 Room Password Auth Gate (HTTP 403 & WS auth_required)'
    );

    // Stage 3: GitHub Pages /NES_Online/ Nostr Auto-Discovery + 60m Auto-Heal
    await app.beacon.publishTunnelState({
      routeId: 'sg1', routeLabel: 'SG-1',
      publicUrl: `http://127.0.0.2:${proxy1.port}`
    });
    browser = await launchHeadlessBrowser(bin, path.join(tmpDir, 'profile'));
    const tabHost = await createCdpTab(
      browser.debugPort,
      `http://127.0.0.1:${hostPort}/?room=NOVA&pass=secret777&nick=HostSG&debug=1`
    );
    const encR = encodeURIComponent(relayUrl);
    const ghUrl = `http://127.0.0.1:${pagesSrv.port}/NES_Online/` +
      `?room=NOVA&pass=secret777&nick=BroGH&relays=${encR}&debug=1`;
    const tabBro = await createCdpTab(browser.debugPort, ghUrl);
    await waitFor(() => tabHost.evaluate(
      `document.getElementById('lobbyP2Name')?.textContent.includes('BroGH')`
    ), 15000, 'GitHub Pages client auto-discovered Host via Room+Pass Nostr');

    // Simulate 60-min Pinggy tunnel rotation -> proxy1 dies, proxy2 published!
    await app.beacon.publishTunnelState({
      routeId: 'sg2', routeLabel: 'SG-2',
      publicUrl: `http://127.0.0.2:${proxy2.port}`
    });
    await proxy1.close();
    proxy1 = null;
    await waitFor(() => tabBro.evaluate(
      `document.getElementById('dbgWssState')?.textContent === 'Connected'` +
        ` && document.getElementById('dbgLog')?.textContent.includes('SG-2')`
    ), 15000, 'GitHub Pages client auto-healed onto rotated Pinggy tunnel');
    assert.strictEqual(
      pagesSrv.missing404s.length, 0,
      `Sub-path 404s: ${pagesSrv.missing404s.join(', ')}`
    );
    // Verify Password input does NOT conflict with hotkeys + OC defaults ON
    await tabBro.evaluate(`(() => {
      const p = document.getElementById('roomPassInput');
      p.value = ''; p.focus(); return document.activeElement === p;
    })()`);
    for (const [k, c] of [
      ['w', 'KeyW'], ['1', 'Digit1'], ['a', 'KeyA'], ['2', 'Digit2'],
      ['s', 'KeyS'], ['3', 'Digit3'], ['z', 'KeyZ'], ['5', 'Digit5']
    ]) {
      await tabBro.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: k, code: c, text: k
      });
      await tabBro.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: k, code: c
      });
    }
    const uiChecks = await tabBro.evaluate(`(async () => {
      window.__copiedInvite = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => { window.__copiedInvite = t; } }
      });
      document.getElementById('copyLinkBtn').click();
      await new Promise((r) => setTimeout(r, 30));
      return {
        passVal: document.getElementById('roomPassInput')?.value,
        slotVal: document.getElementById('saveSlotSelect')?.value,
        ocText: document.getElementById('overclockToggleBtn')?.textContent,
        logo: document.querySelector('.brand-logo')?.textContent.trim(),
        title: document.title,
        lobbyHdr: document.getElementById('lobbyTitleText')?.textContent.trim(),
        roleTxt: document.getElementById('roleBadge')?.textContent.trim(),
        copiedInvite: window.__copiedInvite,
        autoHref: document.getElementById('autoBenchLink')?.href || '',
        netHref: document.getElementById('netBenchLink')?.href || ''
      };
    })()`);
    assert.strictEqual(uiChecks.passVal, 'w1a2s3z5', 'Pass swallowed hotkeys');
    assert.strictEqual(uiChecks.slotVal, '1', 'Pass digits switched save slot');
    assert.strictEqual(uiChecks.ocText, 'OC: ON', 'NES OC should default ON');
    assert.notStrictEqual(uiChecks.logo, 'NES', 'Logo should be multi-console');
    assert.ok(!uiChecks.title.startsWith('NES'), uiChecks.title);
    assert.ok(!uiChecks.lobbyHdr.startsWith('NES'), uiChecks.lobbyHdr);
    assert.ok(!uiChecks.roleTxt.includes('$4016'), uiChecks.roleTxt);
    assert.ok(
      uiChecks.copiedInvite.includes('/NES_Online/?room=NOVA'),
      `Copy Link stripped sub-path: ${uiChecks.copiedInvite}`
    );
    assert.ok(uiChecks.autoHref.includes('/NES_Online/'), uiChecks.autoHref);
    assert.ok(uiChecks.autoHref.includes('server='), uiChecks.autoHref);
    assert.ok(uiChecks.netHref.includes('/NES_Online/'), uiChecks.netHref);
    assert.ok(uiChecks.netHref.includes('server='), uiChecks.netHref);
    const tabStaticAt = await createCdpTab(
      browser.debugPort,
      `http://127.0.0.1:${pagesSrv.port}/NES_Online/autotest.html?gameRoom=Z1`
    );
    await waitFor(() => tabStaticAt.evaluate(`(() => {
      const b = document.getElementById('stateBadge')?.textContent || '';
      const a = document.getElementById('backToGameBtn')?.href || '';
      return b.includes('SERVER REQUIRED') && a.includes('/NES_Online/?room=');
    })()`), 6000, 'Static autotest.html shows SERVER REQUIRED + sub-path back');
    try { tabStaticAt.close(); } catch {}
    console.log(
      '[PASS] 3/4 Real Chrome GitHub Pages /NES_Online/: Room+Pass ' +
        'Discovery, 0 Sub-Path 404s, Pass Hotkeys & 60-Min Auto-Heal Verified'
    );
    try { tabHost.close(); tabBro.close(); } catch {}

    // Stage 4: 100% Serverless WebRTC P2P on GitHub Pages (ZERO Relay Server!)
    const p2pBase = `http://127.0.0.1:${pagesSrv.port}/NES_Online/` +
      `?room=PUREP2P&pass=p2ppass99&relays=${encR}&p2p=1&debug=1`;
    const tabA = await createCdpTab(
      browser.debugPort, `${p2pBase}&nick=HostP2P`
    );
    await waitFor(() => tabA.evaluate(
      `Boolean(document.getElementById('hostP2pBtn'))`
    ), 8000, 'Host P2P button visible on GitHub Pages');
    await tabA.evaluate(`document.getElementById('hostP2pBtn').click(); true`);
    await waitFor(() => tabA.evaluate(
      `document.getElementById('dbgLog')?.textContent` +
        `.includes('P2P Host online')`
    ), 10000, 'P2P Host published encrypted SDP offer to Nostr');

    const tabB = await createCdpTab(
      browser.debugPort, `${p2pBase}&nick=BroP2P`
    );
    await waitFor(() => Promise.all([
      tabA.evaluate(`document.getElementById('dbgWssState')?.textContent`),
      tabB.evaluate(`document.getElementById('dbgWssState')?.textContent`)
    ]).then(([a, b]) => (
      a === 'Connected (P2P)' && b === 'Connected (P2P)' ? true : null
    )), 15000, 'Both browsers opened direct serverless WebRTC P2P channels');

    // Load a real NES ROM into HostP2P -> Send over DataChannel -> 60 FPS sync!
    const romFile = fs.readdirSync(path.join(ROOT_DIR, 'local', 'nes'))
      .find((f) => f.toLowerCase().includes('super mario'));
    const romB64 = fs.readFileSync(path.join(ROOT_DIR, 'local', 'nes', romFile))
      .toString('base64');
    await tabA.evaluate(`(() => {
      const bin = atob(${JSON.stringify(romB64)});
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([u8], 'smb.nes'));
      const inp = document.getElementById('romFileInput');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(() => tabA.evaluate(
      `document.getElementById('romBadge')?.textContent.includes('smb')`
    ), 10000, 'HostP2P loaded local NES ROM');
    await tabA.evaluate(
      `document.getElementById('topSendRomBtn').click(); true`
    );
    await waitFor(() => Promise.all([
      tabA.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`),
      tabB.evaluate(`Number(document.getElementById('dbgFrame')?.textContent)`),
      tabA.evaluate(`document.getElementById('dbgDesyncs')?.textContent`)
    ]).then(([f1, f2, d]) => (f1 >= 25 && f2 >= 25 && d === '0' ? true : null)),
    15000, 'Serverless P2P streamed ROM & synced 25+ frames with 0 desyncs');
    assert.strictEqual(tabA.exceptions.length, 0, tabA.exceptions.join('; '));
    assert.strictEqual(tabB.exceptions.length, 0, tabB.exceptions.join('; '));
    console.log(
      '[PASS] 4/4 Real Chrome Serverless WebRTC P2P on GitHub Pages ' +
        '(0 Relay Server, Direct DataChannel ROM Transfer & 0 Desyncs) Verified'
    );
    try { tabA.close(); tabB.close(); } catch {}
  } finally {
    if (browser?.proc) {
      try { browser.proc.kill('SIGKILL'); } catch {}
      await sleep(150);
    }
    if (proxy1) await proxy1.close();
    if (proxy2) await proxy2.close();
    if (app) await app.close();
    await pagesSrv.close();
    await nostr.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

console.log('=== GitHub Pages Hybrid & Serverless P2P E2E Suite ===\n');
runSuite().catch((err) => {
  console.error('\n[FAIL] GitHub Pages Hybrid Suite Failed:', err);
  process.exit(1);
});
