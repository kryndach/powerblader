// TDD Suite: P2P Ping Channel, Monotonic ROM Progress & Connection Status UX
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createCoopServer } from '../server/relay_server.mjs';
import { verifyBip340 } from '../server/nostr_crypto.mjs';
import { buildGitHubPagesBundle } from './build_gh_pages.mjs';
import {
  sleep, findChromiumBinary, createCdpTab, waitFor, launchHeadlessBrowser
} from './browser_cdp_harness.mjs';
import {
  streamRomToPeer, handleRomTransferMessage
} from '../public/js/rom_archive.mjs';
import { updateTransferUi } from '../public/js/transfer_status_ui.mjs';
import { fetchStripedBinary } from '../public/js/rom_fast_transfer.mjs';
import {
  uint8ToBase64, base64ToUint8
} from '../src/crc32.mjs';
import {
  loadLocalOrSyntheticNesRom, buildFileUploadJs
} from './test_rom_builder_tables.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

async function testUnitP2pPingAndIceConfig() {
  const src = fs.readFileSync(
    path.join(ROOT_DIR, 'public/js/serverless_p2p_socket.mjs'), 'utf8'
  );
  assert.ok(
    !src.includes('stun.cloudflare.com'),
    'Blocked stun.cloudflare.com still in DEFAULT_ICE'
  );
  assert.ok(
    src.includes('peer_ping') && src.includes('peer_pong') &&
      src.includes('0x50') && src.includes('0x51'),
    'peer_ping/peer_pong (JSON + binary) must route over unordered inputDc'
  );
  console.log('[PASS] 1/4 P2P Unordered Ping Channel & Non-Cloudflare STUN');
}

async function testUnitMonotonicProgressAndGzipP2p() {
  // A) Simulate P2P chunked transfer where receiver ACKs trail behind sender
  const romU8 = new Uint8Array(256 * 1024);
  let seed = 0x12345678;
  for (let i = 0; i < romU8.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    romU8[i] = i % 3 === 0 ? 0 : (seed >>> 24) & 0xff;
  }
  const observedPcts = [];
  const sentWire = [];
  let fakeBuf = 0;
  const state = {
    romUint8: romU8, romName: 'kirby_test.nes', romCrc32: 'AABBCCDD',
    isAutoDefaultRom: false, peerConnected: true, localPlayerIndex: 1,
    peerNick: 'Guest', transferStatus: null,
    ws: {
      isServerlessP2p: true, readyState: 1,
      get bufferedAmount() { return fakeBuf; },
      send(s) {
        sentWire.push(s);
        fakeBuf += Math.min(48000, s.length);
      }
    }
  };
  const ui = {
    updateStatusStrip() {},
    showScreenBanner() {},
    resetSendRomButtons() { state.transferStatus = null; },
    setTransferStatus(xfer) {
      updateTransferUi(state, ui, xfer);
      if (state.transferStatus && state.transferStatus.phase === 'sending') {
        observedPcts.push(state.transferStatus.pct);
      }
    }
  };
  const sendProm = streamRomToPeer(
    state, ui, 'sess_new', { frame: 0 }, uint8ToBase64, false
  );
  // Inject lagging receiver ACKs + stale session progress mid-flight
  await sleep(30);
  handleRomTransferMessage({
    type: 'rom_transfer_progress', sessionId: 'sess_old',
    stage: 'downloading', pct: 3
  }, state, ui, {}, () => {}, () => {}, base64ToUint8);
  for (const p of [18, 42, 71, 95]) {
    fakeBuf = Math.max(0, fakeBuf - 90000);
    handleRomTransferMessage({
      type: 'rom_transfer_progress', sessionId: 'sess_new',
      stage: 'downloading', pct: p, loadedBytes: Math.round(2560 * p),
      totalBytes: 256 * 1024
    }, state, ui, {}, () => {}, () => {}, base64ToUint8);
    await sleep(35);
  }
  fakeBuf = 0;
  await sendProm;
  assert.ok(observedPcts.length >= 2, 'Expected sending progress updates');
  for (let i = 1; i < observedPcts.length; i++) {
    assert.ok(
      observedPcts[i] >= observedPcts[i - 1],
      `P2P progress jumped backwards: ${observedPcts.join(' -> ')}`
    );
  }
  const startMsg = JSON.parse(sentWire[0]);
  assert.strictEqual(
    startMsg.payloadEncoding, 'gzip',
    'Expected P2P chunked transfer to gzip-compress compressible ROM'
  );
  assert.ok(
    startMsg.totalBytes < romU8.length * 0.9,
    `Expected gzip savings on P2P ROM, got ${startMsg.totalBytes}`
  );

  // B) Verify Pinggy striped downloader progress never jumps backwards on retry
  const dlPcts = [];
  const total = 400 * 1024;
  const raw = new Uint8Array(total);
  let slice2Fails = 1;
  const mkHdrs = (obj = {}) => {
    const low = {};
    for (const [k, v] of Object.entries(obj)) low[k.toLowerCase()] = v;
    return { get: (k) => low[String(k).toLowerCase()] || null };
  };
  const mockFetch = async (_u, init = {}) => {
    const rHdr = init.headers?.Range || '';
    const m = /bytes=(\d+)-(\d+)/.exec(rHdr);
    const s = Number(m[1]), e = Number(m[2]);
    if (s > 100000 && slice2Fails-- > 0) {
      return { ok: false, status: 502, headers: mkHdrs() };
    }
    const body = raw.subarray(s, e + 1);
    const hdrs = mkHdrs({
      'Content-Range': `bytes ${s}-${e}/${total}`,
      'X-Payload-Encoding': 'identity',
      'X-Rom-Filename': 'test.nes', 'X-Rom-Crc32': '11223344'
    });
    return {
      ok: true, status: 206, headers: hdrs,
      arrayBuffer: async () => body.slice().buffer
    };
  };
  await fetchStripedBinary('http://mock/api/room-rom', {
    concurrency: 2, probeBytes: 65536, sliceBytes: 131072,
    fetchImpl: mockFetch, onProgress: (pct) => dlPcts.push(pct)
  });
  for (let i = 1; i < dlPcts.length; i++) {
    assert.ok(
      dlPcts[i] >= dlPcts[i - 1],
      `Pinggy download progress jumped backwards: ${dlPcts.join(' -> ')}`
    );
  }
  console.log(
    `[PASS] 2/4 Monotonic ROM Progress (P2P=${observedPcts.join('->')}, ` +
      `Gzip=${Math.round(startMsg.totalBytes / 1024)}KB/256KB)`
  );
}

async function startNostrAndStatic(distDir) {
  const events = new Map(), subs = new Set();
  const nSrv = http.createServer((_q, r) => { r.writeHead(200); r.end(); });
  const wss = new WebSocketServer({ server: nSrv });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m[0] === 'EVENT' && m[1]) {
          const ev = m[1];
          const ok = verifyBip340(Buffer.from(ev.id, 'hex'), ev.pubkey, ev.sig);
          ws.send(JSON.stringify(['OK', ev.id, ok, '']));
          if (ok) {
            const d = (ev.tags || []).find((t) => t[0] === 'd')?.[1] || '';
            events.set(`${ev.pubkey}:${d}`, { ev, d });
            for (const s of subs) {
              if (s.ws.readyState === 1 && (!s.d || s.d.includes(d))) {
                s.ws.send(JSON.stringify(['EVENT', s.id, ev]));
              }
            }
          }
        } else if (m[0] === 'REQ' && m[1]) {
          const d = Array.isArray(m[2]?.['#d']) ? m[2]['#d'] : null;
          subs.add({ ws, id: m[1], d });
          for (const it of events.values()) {
            if (!d || d.includes(it.d)) {
              ws.send(JSON.stringify(['EVENT', m[1], it.ev]));
            }
          }
          ws.send(JSON.stringify(['EOSE', m[1]]));
        }
      } catch {}
    });
    ws.on('close', () => {
      for (const s of [...subs]) if (s.ws === ws) subs.delete(s);
    });
  });
  await new Promise((r) => nSrv.listen(0, '127.0.0.1', r));

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
    '.mjs': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm'
  };
  const pSrv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    let rel = u.pathname.replace(/^\/NES_Online/, '') || '/';
    if (rel === '/') rel = '/index.html';
    const full = path.resolve(distDir, `.${rel}`);
    if (!full.startsWith(path.resolve(distDir)) || !fs.existsSync(full)) {
      res.writeHead(404); return res.end('Not found');
    }
    const ext = path.extname(full).toLowerCase();
    const ct = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    fs.createReadStream(full).pipe(res);
  });
  await new Promise((r) => pSrv.listen(0, '127.0.0.1', r));
  return {
    nostrPort: nSrv.address().port, pagesPort: pSrv.address().port,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(() => nSrv.close(() => r())));
      await new Promise((r) => pSrv.close(() => r()));
    }
  };
}

async function testChromeConnectionStatusIndicators() {
  const bin = findChromiumBinary();
  if (!bin) return console.log('[SKIP] No Chrome binary found.');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_ux_status_'));
  const distDir = path.join(tmpDir, 'dist-pages');
  buildGitHubPagesBundle(ROOT_DIR, distDir);
  const net = await startNostrAndStatic(distDir);
  const relayUrl = `ws://127.0.0.1:${net.nostrPort}`;
  const encR = encodeURIComponent(relayUrl);
  let browser = null, app = null;
  try {
    browser = await launchHeadlessBrowser(bin, path.join(tmpDir, 'profile'));
    const base = `http://127.0.0.1:${net.pagesPort}/NES_Online/` +
      `?room=UXROOM&pass=uxpass88&relays=${encR}&p2p=1&debug=1`;

    const tabGuest = await createCdpTab(browser.debugPort, `${base}&nick=P2`);
    await waitFor(() => tabGuest.evaluate(
      `document.getElementById('statusLed')?.classList.contains('err') && ` +
        `Boolean(document.getElementById('connStatePill'))`
    ), 10000, 'Client offline error indicator (red LED + connStatePill)');
    console.log('[PASS] 3/4 Client Offline Error Indicator (Red LED + Guide)');
    const tabHost = await createCdpTab(browser.debugPort, `${base}&nick=Host`);
    await waitFor(() => tabHost.evaluate(
      `Boolean(document.getElementById('hostP2pBtn'))`
    ), 8000, 'Host P2P button ready');
    await tabHost.evaluate(`document.getElementById('hostP2pBtn').click()`);
    await waitFor(() => tabHost.evaluate(`(() => {
      const p = document.getElementById('connStatePill')?.textContent || '';
      const b = document.getElementById('lobbyRoomBadge')?.textContent || '';
      const l = document.getElementById('statusLed')?.className || '';
      return p.includes('HOST') && b.includes('HOST') &&
        !b.includes('OFFLINE') && !l.endsWith('led');
    })()`), 10000, 'Host P2P shows visible HOSTING status before partner');

    await tabGuest.evaluate(`document.getElementById('connectBtn').click()`);
    const readP2p = (t) => t.evaluate(`({
      p: document.getElementById('connStatePill')?.textContent || '',
      pc: document.getElementById('connStatePill')?.className || '',
      bc: document.getElementById('lobbyRoomBadge')?.className || ''
    })`);
    await waitFor(() => Promise.all([readP2p(tabHost), readP2p(tabGuest)])
      .then(([h, g]) => (
        h.p.includes('P2P') && h.pc.includes('ok') && h.bc.includes('ok') &&
        g.p.includes('P2P') && g.pc.includes('ok') && g.bc.includes('ok')
          ? true : null
      )), 15000, 'Both Host & Guest display green P2P CONNECTED badges');

    app = createCoopServer({
      logAccess: false, logsDir: path.join(tmpDir, 'logs'),
      savesDir: path.join(tmpDir, 'saves'),
      secretPath: path.join(tmpDir, 'secret.txt'),
      roomPasswordPath: path.join(tmpDir, 'pass.txt'),
      rendezvousRelays: [relayUrl]
    });
    const hostPort = await app.listen(0, '127.0.0.1');
    app.beacon.publishTunnelState({
      routeId: 'sg1', routeLabel: 'AP-1',
      publicUrl: `http://127.0.0.1:${hostPort}`
    });
    const tabLocal = await createCdpTab(
      browser.debugPort, `http://127.0.0.1:${hostPort}/?room=NOVA&debug=1`
    );
    await waitFor(() => tabLocal.evaluate(
      `(document.getElementById('connStatePill')?.textContent || '')` +
        `.includes('HOST')`
    ), 10000, 'Localhost Host displays live Pinggy/Nostr host-ready pill');
    const rom = loadLocalOrSyntheticNesRom(
      path.join(ROOT_DIR, 'local'), 'super mario', 0
    );
    await tabHost.evaluate(buildFileUploadJs(rom.uint8, 'cached_rom.nes'));
    await waitFor(() => tabHost.evaluate(
      `document.getElementById('cacheFolderBtn')?.textContent?.includes('(1)')`
    ), 10000, 'Cache button shows (1) after loading ROM');
    await tabHost.send('Page.reload', {});
    const cachedVal = await waitFor(() => tabHost.evaluate(`(() => {
      const sel = document.getElementById('localRomSelect');
      const o = [...(sel?.options || [])].find((x) =>
        x.value.startsWith('cached:') && x.textContent.includes('cached_rom')
      );
      const b = document.getElementById('cacheFolderBtn')?.textContent || '';
      return o && b.includes('(1)') ? o.value : null;
    })()`), 10000, 'Reloaded Chrome tab lists [CACHED] ROM in dropdown');
    await tabHost.evaluate(`(() => {
      const sel = document.getElementById('localRomSelect');
      sel.value = ${JSON.stringify(cachedVal)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(() => tabHost.evaluate(
      `document.getElementById('romBadge')?.textContent.includes('cached_rom')`
    ), 10000, 'Selecting [CACHED] ROM after reload boots cleanly');
    console.log(
      '[PASS] 4/4 Real Chrome Connection UX + Post-Reload Auto-Cache Dropdown'
    );
    try { tabHost.close(); tabGuest.close(); tabLocal.close(); } catch {}
  } finally {
    if (browser?.proc) {
      try { browser.proc.kill('SIGKILL'); } catch {}
      await sleep(150);
    }
    if (app) await app.close();
    await net.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

console.log('=== P2P Ping, Monotonic ROM Progress & Connection UX Suite ===\n');
(async () => {
  await testUnitP2pPingAndIceConfig();
  await testUnitMonotonicProgressAndGzipP2p();
  await testChromeConnectionStatusIndicators();
})().catch((err) => {
  console.error('\n[FAIL] P2P UX & Progress Suite Failed:', err);
  process.exit(1);
});
