// Phase 1 & 2 Tests: 2-Way Route Optimizer, Nostr Crypto & join_nes.html
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { WebSocketServer } from 'ws';
import { createCoopServer } from '../server/relay_server.mjs';
import {
  deriveRendezvousKeys, encryptBeaconPayload, decryptBeaconPayload,
  createSignedBeaconEvent, verifyBip340
} from '../server/nostr_crypto.mjs';
import {
  TUNNEL_ROUTES, pickCompetingRoutes, createCandidatePool
} from '../server/tunnel_candidates.mjs';
import {
  selectBestMeasuredRoute, buildMigratedClientUrl
} from '../public/js/route_optimizer.mjs';
import {
  sleep, findChromiumBinary, createCdpTab, waitFor, launchHeadlessBrowser
} from './browser_cdp_harness.mjs';
import { startNetemProxy } from './netem_proxy.mjs';

function testCryptoAndPolicyUnitContracts() {
  const keys = deriveRendezvousKeys('super-secret-room-key-99');
  const payload = { v: 1, room: 'NOVA', ts: 123456, candidates: [] };
  const enc = encryptBeaconPayload(payload, keys.aesKey);
  assert.deepStrictEqual(decryptBeaconPayload(enc, keys.aesKey), payload);
  // Tampered ciphertext must fail GCM auth tag check
  const badBuf = Buffer.from(enc, 'base64');
  badBuf[badBuf.length - 1] ^= 0xff;
  assert.throws(
    () => decryptBeaconPayload(badBuf.toString('base64'), keys.aesKey)
  );

  const ev = createSignedBeaconEvent(payload, keys, 1700000000);
  const idBuf = Buffer.from(ev.id, 'hex');
  assert.strictEqual(verifyBip340(idBuf, ev.pubkey, ev.sig), true);
  const badSig = (ev.sig[0] === '0' ? '1' : '0') + ev.sig.slice(1);
  assert.strictEqual(verifyBip340(idBuf, ev.pubkey, badSig), false);

  // Competing route selector always includes EU when active is SG
  const comp = pickCompetingRoutes(TUNNEL_ROUTES, 'sg1', { sg2: 4, sg3: 9 }, 2);
  assert.strictEqual(comp.length, 2);
  assert.ok(comp.some((r) => r.id === 'eu'), 'Expected EU competing route');
  assert.ok(comp.some((r) => r.id === 'sg2'), 'Expected fastest alt SG route');

  // Route scoring threshold (15ms gain required to avoid churn)
  const stay = selectBestMeasuredRoute([
    { candId: 'sg1', medRttMs: 210, jitterMs: 8, okCount: 4, lossCount: 0 },
    { candId: 'sg2', medRttMs: 202, jitterMs: 8, okCount: 4, lossCount: 0 }
  ], 'sg1', 15);
  assert.strictEqual(stay.shouldSwitch, false);
  const go = selectBestMeasuredRoute([
    { candId: 'sg1', medRttMs: 240, jitterMs: 12, okCount: 4, lossCount: 0 },
    { candId: 'eu', medRttMs: 185, jitterMs: 6, okCount: 4, lossCount: 0 }
  ], 'sg1', 15);
  assert.strictEqual(go.shouldSwitch, true);
  assert.strictEqual(go.winner.candId, 'eu');

  const migrated = buildMigratedClientUrl(
    'https://fast.a.pinggy-free.link/',
    'https://slow.a.pinggy-free.link/?room=NOVA&nick=Bro'
  );
  assert.strictEqual(
    migrated, 'https://fast.a.pinggy-free.link/?room=NOVA&nick=Bro&optimized=1'
  );
  console.log('[PASS] 1/4 BIP-340 Schnorr, AES-GCM & Route Scoring Contracts');
}

async function testCandidatePoolLifecycle() {
  const killed = [];
  let active = {
    route: TUNNEL_ROUTES.find((r) => r.id === 'sg1'),
    handle: {
      publicUrl: 'https://sg1.pinggy-free.link',
      altUrl: 'https://sg1.free.pinggy.net',
      kill: () => killed.push('sg1')
    }
  };
  const pool = createCandidatePool({
    getActive: () => active,
    setActive: (route, handle) => { active = { route, handle }; },
    spawnRoute: async (r) => ({
      publicUrl: `https://${r.id}.pinggy-free.link`,
      altUrl: `https://${r.id}.free.pinggy.net`,
      kill: () => killed.push(r.id)
    }),
    getProbes: () => ({ sg1: 4, sg2: 6, eu: 150 }),
    routes: TUNNEL_ROUTES,
    graceMs: 80, ttlMs: 5000
  });
  const opened = await pool.openPool(2);
  assert.strictEqual(opened.ok, true);
  assert.strictEqual(opened.candidates.length, 6);
  const prom = pool.promote('eu__alt');
  assert.strictEqual(prom.ok, true);
  assert.strictEqual(prom.switched, true);
  assert.strictEqual(prom.publicUrl, 'https://eu.free.pinggy.net');
  assert.ok(killed.includes('sg2'), 'Losing candidate sg2 not killed');
  assert.ok(!killed.includes('sg1'), 'Old active killed before grace delay');
  await sleep(140);
  assert.ok(killed.includes('sg1'), 'Old active not killed after grace delay');
  pool.cleanupAll();
  console.log(
    '[PASS] 2/4 Candidate Pool Open, Alt-Domain Promotion & Grace Kill'
  );
}

async function startMockNostrRelay() {
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
            events.set(`${ev.pubkey}:${dTag}`, ev);
            for (const s of subs) {
              if (s.ws.readyState === 1) {
                s.ws.send(JSON.stringify(['EVENT', s.subId, ev]));
              }
            }
          }
        } else if (msg[0] === 'REQ' && msg[1]) {
          const subId = msg[1];
          subs.add({ ws, subId });
          for (const ev of events.values()) {
            ws.send(JSON.stringify(['EVENT', subId, ev]));
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

async function runChromeRouteAndRendezvousE2E() {
  const bin = findChromiumBinary();
  if (!bin) return console.log('[SKIP] No local Chrome binary found.');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_route_e2e_'));
  const nostr = await startMockNostrRelay();
  const relayUrl = `ws://127.0.0.1:${nostr.port}`;
  let slowProxy = null, fastProxy = null, app = null, browser = null;
  const killedHandles = [];
  try {
    app = createCoopServer({
      logAccess: false,
      logsDir: path.join(tmpDir, 'logs'),
      savesDir: path.join(tmpDir, 'saves'),
      secretPath: path.join(tmpDir, 'secret.txt'),
      rendezvousRelays: [relayUrl],
      candidateGraceMs: 600,
      probeTcpFn: async (host) => (host.includes('ap.1') ? 4 : 40),
      spawnTunnelFn: async (route) => {
        if (route.id === 'sg1') {
          return {
            publicUrl: `http://127.0.0.2:${slowProxy.port}`,
            altUrl: null,
            kill: () => killedHandles.push('sg1')
          };
        }
        return {
          publicUrl: `http://127.0.0.2:${fastProxy.port}`,
          altUrl: null,
          kill: () => killedHandles.push(route.id)
        };
      }
    });
    const hostPort = await app.listen(0, '127.0.0.1');
    slowProxy = await startNetemProxy(hostPort, { rttMs: 180 });
    fastProxy = await startNetemProxy(hostPort, { rttMs: 10 });

    await app.tunnelMgr.activateRoute('sg1');

    // Verify Host-only 403 security when accessed via remote tunnel headers
    const leakCode = await new Promise((resolve, reject) => {
      const req = http.get({
        host: '127.0.0.1', port: hostPort, path: '/api/join-file',
        headers: { Host: 'bro.pinggy-free.link', 'X-Forwarded-For': '91.1.2.3' }
      }, (r) => { r.resume(); resolve(r.statusCode); });
      req.on('error', reject);
    });
    assert.strictEqual(leakCode, 403, '/api/join-file must be localhost-only!');

    browser = await launchHeadlessBrowser(bin, path.join(tmpDir, 'profile'));

    // Phase 1 E2E: Auto 2-way probe on slowProxy -> auto-redirect to fastProxy
    const tab1 = await createCdpTab(
      browser.debugPort,
      `http://127.0.0.1:${hostPort}/?room=ROUTE1&nick=HostSG`
    );
    const tab2 = await createCdpTab(
      browser.debugPort,
      `http://127.0.0.2:${slowProxy.port}/?room=ROUTE1&nick=BroRU`
    );
    await waitFor(() => tab2.evaluate('window.location.href').then((u) => (
      u.includes(`:${fastProxy.port}/`) && u.includes('optimized=1') ? u : null
    )), 15000, 'P2 auto-migrated from slowProxy to fastProxy');

    await waitFor(() => tab1.evaluate(
      `document.getElementById('lobbyP2Name')?.textContent.includes('BroRU')`
    ), 8000, 'P2 auto-rejoined room after seamless migration');
    await sleep(900);
    assert.ok(killedHandles.includes('sg1'), 'Old slow tunnel not freed');
    assert.strictEqual(tab1.exceptions.length, 0, tab1.exceptions.join('; '));
    assert.strictEqual(tab2.exceptions.length, 0, tab2.exceptions.join('; '));
    console.log(
      '[PASS] 3/4 Real Chrome Phase 1: Auto 2-Way Probe (180ms -> 10ms) & ' +
        'Zero-Copy Redirect Verified'
    );
    try { tab2.close(); } catch {}

    // Phase 2 E2E: Publish candidates to Nostr -> open file:// join_nes.html
    await app.beacon.publishTunnelState(
      {
        routeId: 'sg1', routeLabel: 'SG-1 Slow',
        publicUrl: `http://127.0.0.2:${slowProxy.port}`
      },
      [{ id: 'eu', label: 'EU Fast', url: `http://127.0.0.2:${fastProxy.port}` }]
    );
    const joinHtml = app.beacon.buildStandaloneJoinHtml('ROUTE1');
    const joinPath = path.join(tmpDir, 'join_nes.html');
    fs.writeFileSync(joinPath, joinHtml, 'utf8');

    const tabJoin = await createCdpTab(
      browser.debugPort, pathToFileURL(joinPath).href
    );
    await waitFor(() => tabJoin.evaluate('window.location.href').then((u) => (
      u.includes(`:${fastProxy.port}/`) && u.includes('room=ROUTE1') ? u : null
    )), 15000, 'file:// join_nes.html decrypted beacon & chose fastProxy');

    await waitFor(() => tab1.evaluate(
      `document.getElementById('lobbyP2Name')?.textContent.includes('Bro')`
    ), 8000, 'Partner auto-joined room via permanent join_nes.html');
    assert.strictEqual(
      tabJoin.exceptions.length, 0, tabJoin.exceptions.join('; ')
    );
    console.log(
      '[PASS] 4/4 Real Chrome Phase 2: Encrypted Nostr Beacon & ' +
        'file:// join_nes.html Zero-Link Auto-Join Verified'
    );
    try { tab1.close(); tabJoin.close(); } catch {}
  } finally {
    if (browser?.proc) {
      try { browser.proc.kill('SIGKILL'); } catch {}
      await sleep(150);
    }
    if (slowProxy) await slowProxy.close();
    if (fastProxy) await fastProxy.close();
    if (app) await app.close();
    await nostr.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log('=== Phase 1 & 2 Route Optimizer + Zero-Link P2P Suite ===\n');
  testCryptoAndPolicyUnitContracts();
  await testCandidatePoolLifecycle();
  await runChromeRouteAndRendezvousE2E();
}

main().catch((err) => {
  console.error('\n[FAIL] Route & Rendezvous Suite Failed:', err);
  process.exit(1);
});
