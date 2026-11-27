// TDD Verification Suite for Track B1: Multi-Path RTT Race & Regional TURN/443
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildGameplayIceServers, classifyIceCandidateType
} from '../public/js/ice_config.mjs';
import {
  rankTransportPaths, createMultiPathRacer
} from '../public/js/multipath_racer.mjs';
import { createRouteOptimizer } from '../public/js/route_optimizer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function testB1aRegionalTurn443AndCustomIce() {
  const ice = buildGameplayIceServers();
  const urls = ice.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
  assert.ok(
    urls.some((u) => u.startsWith('stun:stun.l.google.com')),
    'Expected Google STUN in gameplay ICE servers'
  );
  assert.ok(
    urls.some((u) => u.startsWith('turn:') && u.includes(':443')),
    'Expected Port 443 TURN fallback in gameplay ICE servers'
  );
  assert.ok(
    urls.some((u) => u.includes(':443?transport=tcp')),
    'Expected TCP/443 TURN fallback for strict UDP-blocked firewalls'
  );
  assert.ok(
    !urls.some((u) => u.includes('cloudflare.com')),
    'Blocked Cloudflare STUN must NOT be in default gameplay ICE list'
  );

  // BYO custom TURN via URL param (e.g. self-hosted Oracle coturn)
  const custom = buildGameplayIceServers({
    search: '?turn=turn:my-relay.example:443&turnUser=u1&turnPass=p1'
  });
  const firstUrls = Array.isArray(custom[0].urls)
    ? custom[0].urls : [custom[0].urls];
  assert.ok(
    firstUrls.includes('turn:my-relay.example:443') &&
    custom[0].username === 'u1' && custom[0].credential === 'p1',
    'BYO ?turn= custom TURN server must take highest priority'
  );

  assert.strictEqual(classifyIceCandidateType('host'), 'direct_p2p');
  assert.strictEqual(classifyIceCandidateType('srflx'), 'direct_p2p');
  assert.strictEqual(classifyIceCandidateType('prflx'), 'direct_p2p');
  assert.strictEqual(classifyIceCandidateType('relay'), 'turn_443');

  // Verify both webrtc_p2p.mjs & serverless_p2p_socket.mjs wire ice_config.mjs
  const p2pSrc = fs.readFileSync(
    path.join(ROOT, 'public/js/webrtc_p2p.mjs'), 'utf8'
  );
  const slSrc = fs.readFileSync(
    path.join(ROOT, 'public/js/serverless_p2p_socket.mjs'), 'utf8'
  );
  assert.ok(
    p2pSrc.includes('buildGameplayIceServers'),
    'webrtc_p2p.mjs must use buildGameplayIceServers()'
  );
  assert.ok(
    slSrc.includes('buildGameplayIceServers'),
    'serverless_p2p_socket.mjs must use buildGameplayIceServers()'
  );
  console.log('[PASS] B1a: Regional TURN/443, BYO TURN & ICE Classification');
}

function testB1bMultiPathRttRaceAndHysteresis() {
  // Race 4 real paths: Direct P2P (142ms) vs TURN/443 (185ms) vs SG (192ms)
  // vs EU (310ms) -> Direct P2P wins!
  const ranked = rankTransportPaths([
    { id: 'wss_eu', kind: 'wss', label: 'Pinggy EU', rttMs: 310, jitterMs: 18 },
    { id: 'wss_sg', kind: 'wss', label: 'Pinggy SG', rttMs: 192, jitterMs: 10 },
    {
      id: 'turn_443', kind: 'turn_443', label: 'TURN/443',
      rttMs: 185, jitterMs: 6
    },
    {
      id: 'direct_p2p', kind: 'direct_p2p', label: 'Direct P2P',
      rttMs: 142, jitterMs: 4
    }
  ]);
  assert.strictEqual(ranked[0].id, 'direct_p2p');
  assert.strictEqual(ranked[1].id, 'turn_443');
  assert.strictEqual(ranked[2].id, 'wss_sg');

  // Stateful racer with hysteresis: starts on wss_sg (190ms), TURN arrives
  // at 186ms (only 4ms gain < 12ms threshold) -> stays on wss_sg (no flap!)
  let now = 10000;
  const racer = createMultiPathRacer({ now: () => now, minGainMs: 12 });
  racer.recordSample('wss_sg', { kind: 'wss', label: 'Pinggy SG', rttMs: 190 });
  racer.recordSample('wss_sg', { kind: 'wss', label: 'Pinggy SG', rttMs: 192 });
  assert.strictEqual(racer.selectActivePath().id, 'wss_sg');

  const tMeta = { kind: 'turn_443', label: 'TURN/443', rttMs: 186 };
  racer.recordSample('turn_443', tMeta);
  racer.recordSample('turn_443', tMeta);
  assert.strictEqual(
    racer.selectActivePath().id, 'wss_sg',
    'Small 4-6ms gain must NOT flap active path!'
  );

  // Direct P2P opens at 138ms (>50ms faster) after cooldown -> switches!
  now += 7000;
  racer.recordSample('direct_p2p', {
    kind: 'direct_p2p', label: 'Direct P2P', rttMs: 138
  });
  racer.recordSample('direct_p2p', {
    kind: 'direct_p2p', label: 'Direct P2P', rttMs: 140
  });
  assert.strictEqual(
    racer.selectActivePath().id, 'direct_p2p',
    'Expected seamless switch to Direct P2P when >12ms faster!'
  );

  // If P2P degrades to 260ms, racer falls back to TURN/443 (186ms); if TURN
  // drops too, it falls back cleanly to Pinggy SG (190ms)!
  now += 7000;
  racer.recordSample('direct_p2p', {
    kind: 'direct_p2p', label: 'Direct P2P', rttMs: 260
  });
  racer.recordSample('direct_p2p', {
    kind: 'direct_p2p', label: 'Direct P2P', rttMs: 265
  });
  assert.strictEqual(
    racer.selectActivePath().id, 'turn_443',
    'Expected automatic fallback to fastest remaining path (TURN/443)!'
  );
  racer.removePath('turn_443');
  assert.strictEqual(
    racer.selectActivePath().id, 'wss_sg',
    'Expected automatic fallback to Pinggy SG when TURN/443 drops!'
  );
  console.log('[PASS] B1b: Multi-Path 2-Way RTT Race & Anti-Flap Hysteresis');
}

async function testB1cSeamlessNoReloadRouteSwitch() {
  let hotSwitchedUrl = null;
  let hardReloaded = false;
  const prevWin = globalThis.window;
  try {
    globalThis.window = {
      location: {
        href: 'https://user.github.io/NES_Online/?room=NOVA&server=https://old.pinggy.link',
        search: '?room=NOVA&server=https://old.pinggy.link',
        replace: () => { hardReloaded = true; }
      },
      history: { replaceState() {} }
    };
    const state = {
      isExternalServer: true,
      apiBaseUrl: 'https://old.pinggy.link',
      wsBaseUrl: 'wss://old.pinggy.link'
    };
    const banners = [];
    const ui = {
      logDebug() {},
      showScreenBanner(t) { banners.push(t); }
    };
    const opt = createRouteOptimizer(state, ui, null, {
      onHotRouteSwitch: (url) => { hotSwitchedUrl = url; }
    });
    const handled = await opt.handleRouteMessage({
      type: 'route_migrate',
      url: 'https://fast-sg.pinggy.link',
      label: 'Pinggy SG',
      rttMs: 175
    });
    assert.strictEqual(handled, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(
      hardReloaded, false,
      'Seamless route switch must NOT trigger window.location.replace reload!'
    );
    assert.strictEqual(
      hotSwitchedUrl, 'https://fast-sg.pinggy.link',
      `Expected seamless WS switch to fast-sg URL, got: ${hotSwitchedUrl}`
    );
    assert.strictEqual(state.apiBaseUrl, 'https://fast-sg.pinggy.link');
    assert.strictEqual(state.wsBaseUrl, 'wss://fast-sg.pinggy.link');
  } finally {
    globalThis.window = prevWin;
  }
  console.log('[PASS] B1c: Seamless In-Place Route Switch (Zero Page Reload)');
}

testB1aRegionalTurn443AndCustomIce();
testB1bMultiPathRttRaceAndHysteresis();
await testB1cSeamlessNoReloadRouteSwitch();
console.log('\nALL TRACK B1 TESTS PASSED!');
