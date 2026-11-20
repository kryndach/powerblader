// Isolated SOLID Module Contract Tests (Store, Router, Rollback, WASM, Relay)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createConsoleState, resetPingWindow, resetPeerSessionState,
  clearActiveRomTransfers
} from '../public/js/session_store.mjs';
import { createInputRouter } from '../public/js/input_router.mjs';
import { computeRecommendedInputDelay } from '../src/netplay_rollback.mjs';
import {
  RGB565_TO_BGR24, listZipEntryNames, createMinimalArcadeTestZip
} from '../src/wasm_runtime_loader.mjs';
import {
  handleAutotestReportWs, handleGameplayTelemetryWs
} from '../server/telemetry_relay_handlers.mjs';
import {
  isCpuInTightWaitLoop, setNesOverclockEnabled
} from '../src/ppu_sprite_and_overclock.mjs';
import { extractRomFromFile } from '../server/archive_extractor.mjs';
import { RollbackNetplayEngine } from '../src/netplay_engine.mjs';
import {
  createShadowWorkerController
} from '../src/shadow_rollback_worker_core.mjs';
import { createShadowRollbackHost } from '../src/shadow_rollback_host.mjs';
import { computeRomCrc32 } from '../src/crc32.mjs';
import {
  attachCacheDirectory, getCachedRomByCrc, putCachedRomByCrc,
  clearMemRomCacheForTests
} from '../public/js/rom_idb_cache.mjs';
import {
  resolveServerEndpoints, buildApiUrl, buildWsUrl
} from '../public/js/server_endpoint.mjs';
import { buildMigratedClientUrl } from '../public/js/route_optimizer.mjs';

function testSessionStoreContracts() {
  const st = createConsoleState();
  let aborted = false, resetCalled = false;
  st.peerConnected = true;
  st.partnerRomCrc32 = 'ABCD1234';
  st.matchStarted = true;
  st.rttMs = 240;
  st._rttSamples = [230, 240, 250];
  st.activeRomAbortCtrl = { abort: () => { aborted = true; } };
  const ui = { resetSendRomButtons: () => { resetCalled = true; } };

  clearActiveRomTransfers(st, ui);
  assert.strictEqual(aborted, true);
  assert.strictEqual(resetCalled, true);
  assert.strictEqual(st.activeRomAbortCtrl, null);

  resetPingWindow(st);
  assert.strictEqual(st.rttMs, 0);
  assert.deepStrictEqual(st._rttSamples, []);

  st.peerConnected = true;
  st.rttMs = 199;
  resetPeerSessionState(st, ui);
  assert.strictEqual(st.peerConnected, false);
  assert.strictEqual(st.partnerRomCrc32, null);
  assert.strictEqual(st.matchStarted, false);
  assert.strictEqual(st.rttMs, 0);
}

function testInputRouterDeduplicationContract() {
  let delivered = 0;
  const st = createConsoleState();
  st.peerConnected = true;
  st.engine = { receiveRemoteInputPacket: () => { delivered++; } };
  const router = createInputRouter(st);

  const pktA = { sessionId: 's', startFrame: 10, inputs: [3] };
  const pktB = { sessionId: 's', startFrame: 11, inputs: [2] };
  assert.strictEqual(router.routeNetplayInput(pktA), true);
  assert.strictEqual(router.routeNetplayInput(pktB), true);
  assert.strictEqual(router.routeNetplayInput(pktA), false);
  assert.strictEqual(router.routeNetplayInput(pktB), false);
  assert.strictEqual(delivered, 2);
  assert.strictEqual(st.rxCountThisSec, 2);

  // Overflow 128-key FIFO cap cleanly without unbounded memory growth
  for (let f = 100; f < 300; f++) {
    router.routeNetplayInput({ sessionId: 's', startFrame: f, inputs: [1] });
  }
  assert.ok(st.rxInputDedupSet.size <= 128);
}

function testRollbackDelayHysteresisAndWasmHelpers() {
  assert.strictEqual(computeRecommendedInputDelay(50, 5, 0, null), 2);
  assert.strictEqual(computeRecommendedInputDelay(120, 5, 0, null), 3);
  assert.strictEqual(computeRecommendedInputDelay(230, 10, 1, null), 4);
  assert.strictEqual(computeRecommendedInputDelay(350, 20, 2, null), 5);
  // Hysteresis prevents jittering from 4 -> 5 at boundary 315ms
  assert.strictEqual(computeRecommendedInputDelay(315, 0, 0, 4), 4);

  assert.strictEqual(RGB565_TO_BGR24[0xf800], 0x0000ff); // Pure red RGB565
  assert.strictEqual(RGB565_TO_BGR24[0x001f], 0xff0000); // Pure blue RGB565
  const miniZip = createMinimalArcadeTestZip();
  assert.deepStrictEqual(listZipEntryNames(miniZip), ['d26-01.ic7']);

  // Verify split arcade clone ZIP (tgm2p.zip) auto-merges sibling parent ZIP
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_arc_merge_'));
  try {
    const parentZip = Buffer.from(miniZip);
    // Build a 1-entry child ZIP with a different filename ("1b.u22")
    const childZip = Buffer.from(miniZip);
    const nameOff = childZip.indexOf(Buffer.from('d26-01.ic7'));
    childZip.write('1b.u22    ', nameOff, 10, 'utf8');
    const cdOff = childZip.lastIndexOf(Buffer.from('d26-01.ic7'));
    childZip.write('1b.u22    ', cdOff, 10, 'utf8');
    fs.writeFileSync(path.join(tmp, 'tgm2.zip'), parentZip);
    const childPath = path.join(tmp, 'tgm2p.zip');
    fs.writeFileSync(childPath, childZip);
    const merged = extractRomFromFile(childPath);
    const names = listZipEntryNames(new Uint8Array(merged.romBuffer));
    assert.ok(names.includes('d26-01.ic7'), 'Parent ZIP entry missing!');
    assert.ok(names.some((n) => n.startsWith('1b.u22')), 'Child entry missing');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testServerTelemetryRelayHandlers() {
  let savedAuto = 0, savedTel = 0, sent = [], bcast = [];
  const trackers = {
    autotestSession: { pc1: null, pc2: null, combinedText: 'REPORT_OK' },
    gameplayTelemetrySession: { pc1: null, pc2: null },
    saveAutotestReportToDisk: () => { savedAuto++; },
    saveGameplayTelemetryToDisk: () => { savedTel++; }
  };
  const peer = { roomCode: 'NOVA', clientId: 'c1', playerIndex: 1 };
  handleAutotestReportWs(
    peer, { report: { playerIndex: 2, isFinal: true } }, trackers,
    { logAccess: false }, (p, m) => sent.push(m), (_r, _c, m) => bcast.push(m)
  );
  assert.strictEqual(savedAuto, 1);
  assert.strictEqual(trackers.autotestSession.pc2.isFinal, true);
  assert.strictEqual(sent[0].combinedText, 'REPORT_OK');
  assert.strictEqual(bcast[0].combinedText, 'REPORT_OK');

  handleGameplayTelemetryWs(
    peer, { telemetry: { playerIndex: 1, rttMs: 215 } }, trackers
  );
  assert.strictEqual(savedTel, 1);
  assert.strictEqual(trackers.gameplayTelemetrySession.pc1.rttMs, 215);
}

function testOverclockWaitLoopContract() {
  const mkCpu = (pc, bytes, sp = 0xfa) => {
    const mem = new Uint8Array(0x10000);
    for (let i = 0; i < bytes.length; i++) mem[(pc + i) & 0xffff] = bytes[i];
    return { REG_PC: (pc - 1) & 0xffff, REG_SP: sp, mem };
  };
  const wait = (pc, bytes) => isCpuInTightWaitLoop(mkCpu(pc, bytes));
  // True wait loops: JMP self, LDA zp + BNE -4, BIT abs + BPL -5
  assert.strictEqual(wait(0x8057, [0x4c, 0x57, 0x80]), true);
  assert.strictEqual(wait(0xc1ed, [0xa5, 0x2f, 0xd0, 0xfc]), true);
  assert.strictEqual(wait(0x8000, [0x2c, 0x02, 0x20, 0x10, 0xfb]), true);
  // False positives rejected: Battletoads SBC $52; BCS -4 and DEC $10; BNE -4
  assert.strictEqual(wait(0x8c09, [0xe5, 0x52, 0xb0, 0xfc]), false);
  assert.strictEqual(wait(0x8c0b, [0xb0, 0xfc]), false);
  assert.strictEqual(wait(0x9000, [0xc6, 0x10, 0xd0, 0xfc]), false);

  const mock = { ppu: { _overclockEnabled: false, _hasTightWaitLoop: true } };
  assert.strictEqual(setNesOverclockEnabled(mock, true), true);
  assert.strictEqual(mock.ppu._overclockEnabled, true);
  assert.strictEqual(setNesOverclockEnabled(mock, false), false);
  assert.strictEqual(mock.ppu._hasTightWaitLoop, false);
}

function createMockArcadeCore() {
  let acc = 0x12345678, stepCnt = 0;
  const fb = new Uint32Array(16);
  const saveBytes = () => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setUint32(0, acc >>> 0, true);
    new DataView(b.buffer).setUint32(4, stepCnt >>> 0, true);
    return b;
  };
  return {
    systemId: 'arcade', width: 4, height: 4, opts: {},
    stepFrame(p1, p2) {
      stepCnt++;
      acc = (Math.imul(acc, 31) + p1 * 17 + p2 * 29 + stepCnt) >>> 0;
      fb[0] = acc;
    },
    getFrameBuffer: () => fb,
    saveStateBytes: saveBytes,
    loadStateBytes(bytes) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      acc = dv.getUint32(0, true);
      stepCnt = dv.getUint32(4, true);
    },
    computeHash: () => acc >>> 0,
    getWasmModule: () => ({}),
    getRomBytes: () => new Uint8Array(4),
    getRomName: () => 'mock.zip'
  };
}

async function testShadowRollbackContracts() {
  const cShadow = createMockArcadeCore(), cSync = createMockArcadeCore();
  const e1 = new RollbackNetplayEngine(cShadow, {
    localPlayer: 1, online: true, inputDelayFrames: 0
  });
  const e2 = new RollbackNetplayEngine(cSync, {
    localPlayer: 2, online: true, inputDelayFrames: 0
  });
  let onHostMsg = null;
  const ctrl = createShadowWorkerController(
    (msg) => setTimeout(() => onHostMsg?.(msg), 0),
    { coreFactory: async () => createMockArcadeCore(), chunkFrames: 2 }
  );
  const host = createShadowRollbackHost(cShadow, {
    transport: {
      onMessage: (fn) => { onHostMsg = fn; },
      postMessage: (m) => setTimeout(() => ctrl.handleMessage(m), 0),
      terminate: () => {}
    }
  });
  e1.attachShadowRollback(host);
  assert.strictEqual(await host.waitUntilSynced(2000), true);

  const q12 = [], q21 = [];
  for (let f = 0; f < 75; f++) {
    while (q12.length && q12[0].at <= f) {
      e2.receiveRemoteInputPacket(q12.shift().p);
    }
    while (q21.length && q21[0].at <= f) {
      e1.receiveRemoteInputPacket(q21.shift().p);
    }
    const r1 = e1.stepNetplayFrame((f % 5) === 0 ? 1 : 0);
    const r2 = e2.stepNetplayFrame((f % 7) === 0 ? 2 : 0);
    if (r1.packetToSend) q12.push({ at: f + 6, p: r1.packetToSend });
    if (r2.packetToSend) q21.push({ at: f + 6, p: r2.packetToSend });
    await new Promise((r) => setTimeout(r, 2));
  }
  while (q12.length) e2.receiveRemoteInputPacket(q12.shift().p);
  while (q21.length) e1.receiveRemoteInputPacket(q21.shift().p);
  for (let i = 0; i < 6; i++) {
    const r1 = e1.stepNetplayFrame(0), r2 = e2.stepNetplayFrame(0);
    if (r1.packetToSend) e2.receiveRemoteInputPacket(r1.packetToSend);
    if (r2.packetToSend) e1.receiveRemoteInputPacket(r2.packetToSend);
    await host.flush(e1, 2000);
  }
  assert.strictEqual(e1.desyncCount + e2.desyncCount, 0, 'Shadow desynced');
  assert.strictEqual(cShadow.computeHash(), cSync.computeHash(), 'Hash diff');
  assert.strictEqual(e1.localHashes.get(30), e2.localHashes.get(30), '30f');
  assert.strictEqual(e1.localHashes.get(60), e2.localHashes.get(60), '60f');
  assert.ok(host.getStats().shadowSwaps > 0, 'Expected shadow swaps > 0');

  // Verify resetTimeline bumps epoch and re-syncs cleanly without stale leaks
  e1.resetTimeline(0, 'epoch2');
  assert.strictEqual(await host.waitUntilSynced(2000), true);
  e1.destroy();
}

async function testRomFolderCacheAndCrossOriginEndpoints() {
  clearMemRomCacheForTests();
  const files = new Map();
  const mkFile = (name) => ({
    kind: 'file', name,
    async getFile() {
      const b = files.get(name);
      return {
        size: b.byteLength,
        arrayBuffer: async () =>
          b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      };
    },
    async createWritable() {
      const parts = [];
      return {
        write: async (d) => parts.push(new Uint8Array(d)),
        close: async () => { files.set(name, Buffer.concat(parts)); }
      };
    }
  });
  const rawRom = new Uint8Array([0x4e, 0x45, 0x53, 0x1a, 1, 2, 3, 4, 5, 6]);
  const rawCrc = computeRomCrc32(rawRom);
  files.set('Battletoads.nes', rawRom);
  const mockDir = {
    name: 'NES_Cache',
    async *values() { for (const k of files.keys()) yield mkFile(k); },
    getFileHandle: async (n) => mkFile(n),
    removeEntry: async (n) => files.delete(n)
  };
  const origIdb = globalThis.indexedDB;
  globalThis.indexedDB = {};
  try {
    const info = await attachCacheDirectory(mockDir, { persist: false });
    assert.strictEqual(info.connected && info.count === 1, true);
    const hit1 = await getCachedRomByCrc(rawCrc);
    assert.strictEqual(hit1?.source, 'folder');
    assert.deepStrictEqual(hit1.u8, rawRom);
    const wasmBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    await putCachedRomByCrc('WASM_FBNEO_V3', 'fbneo_arcade.wasm', wasmBytes);
    assert.ok(files.has('WASM_FBNEO_V3.wasm'), 'WASM file missing');
    const hitW = await getCachedRomByCrc('WASM_FBNEO_V3');
    assert.deepStrictEqual(hitW?.u8, wasmBytes);
  } finally {
    clearMemRomCacheForTests();
    globalThis.indexedDB = origIdb;
  }

  const loc = {
    origin: 'https://egor.github.io', protocol: 'https:', host: 'egor.github.io'
  };
  const ep = resolveServerEndpoints(
    '?server=https://abc.run.pinggy-free.link/&room=NOVA', loc
  );
  assert.strictEqual(ep.isExternalServer, true);
  assert.strictEqual(
    buildApiUrl(ep, '/api/local-roms'),
    'https://abc.run.pinggy-free.link/api/local-roms'
  );
  assert.strictEqual(
    buildWsUrl(ep, '/ws'), 'wss://abc.run.pinggy-free.link/ws'
  );
  const prevUrl =
    'https://egor.github.io/nes/?server=https://slow.pinggy-free.link&room=NOVA';
  const mig = buildMigratedClientUrl('https://fast.pinggy-free.link', prevUrl);
  assert.ok(mig.startsWith('https://egor.github.io/nes/?server='));
  assert.ok(mig.includes('fast.pinggy-free.link') && mig.includes('optimized'));
}

export async function runModuleContractSuite() {
  console.log('=== SOLID Module Contract Test Suite ===\n');
  testSessionStoreContracts();
  testInputRouterDeduplicationContract();
  testRollbackDelayHysteresisAndWasmHelpers();
  testServerTelemetryRelayHandlers();
  testOverclockWaitLoopContract();
  await testShadowRollbackContracts();
  await testRomFolderCacheAndCrossOriginEndpoints();
  console.log(
    '[PASS] SessionStore, InputRouter, RollbackPolicy, OverclockWait, ' +
      'ShadowRollback, FolderCache, ServerEndpoint & Telemetry Verified'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)) {
  runModuleContractSuite().catch((err) => {
    console.error('[FAIL] Module Contract Suite Failed:', err);
    process.exit(1);
  });
}
