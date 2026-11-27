// TDD Regression Suite: Audit Priority 3 (ICE, Audio, Async/Fetch, Pacing, OC)
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as jsnesMod from 'jsnes';
import { buildGameplayIceServers } from '../public/js/ice_config.mjs';
import { createAudioDrcEngine } from '../public/js/audio_drc.mjs';
import { setupHybridConnectionUi } from '../public/js/hybrid_connect.mjs';
import { handleRomTransferMessage } from '../public/js/rom_archive.mjs';
import {
  fetchStripedBinary, uploadRomToServerCache
} from '../public/js/rom_fast_transfer.mjs';
import { stepPacingAccumulator } from '../public/js/frame_loop.mjs';
import { resolveSnapshotForSync } from '../src/shadow_rollback_apply.mjs';
import {
  decodeNesStateBytes
} from '../src/universal_worker_core_factory.mjs';
import { fetchAndValidateBrowserWasm } from '../src/wasm_runtime_loader.mjs';
import {
  NesNetplayEngine, computeDeterministicHash
} from '../src/netplay_engine.mjs';
import { isCpuInTightWaitLoop } from '../src/ppu_sprite_and_overclock.mjs';
import { createDualControllerTestRom } from './test_rom_builder_tables.mjs';

const jsnes = jsnesMod.NES ? jsnesMod : jsnesMod.default;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function testP3_9IceTurnValidationAndTlsFallback() {
  const noCred = buildGameplayIceServers({
    search: '?turn=turn:bad.example:443'
  });
  const allUrls = noCred.flatMap((s) =>
    Array.isArray(s.urls) ? s.urls : [s.urls]
  );
  assert.ok(!allUrls.some((u) => u.includes('bad.example')));

  const withCred = buildGameplayIceServers({
    search: '?turn=turns:ok.example:443?transport=tcp&turnUser=u&turnPass=p'
  });
  assert.strictEqual(withCred[0].urls, 'turns:ok.example:443?transport=tcp');
  assert.strictEqual(withCred[0].username, 'u');
  assert.strictEqual(withCred[0].credential, 'p');

  const badScheme = buildGameplayIceServers({
    search: '?turn=http://not-ice.example&turnUser=u&turnPass=p'
  });
  const badUrls = badScheme.flatMap((s) =>
    Array.isArray(s.urls) ? s.urls : [s.urls]
  );
  assert.ok(!badUrls.some((u) => u.includes('not-ice.example')));
  assert.ok(allUrls.some((u) => u.startsWith('turns:') && u.includes(':443')));
  console.log('[PASS] P3-9: ICE Credential Validation & turns: TLS Fallback');
}

async function testP3_10AudioGestureUnlockAndStaleScriptCore() {
  const prevWin = globalThis.window;
  const prevAC = globalThis.AudioContext;
  const prevAWN = globalThis.AudioWorkletNode;
  const listeners = new Map();
  let ctxState = 'suspended', resumeCalls = 0;

  class MockWorkletNode {
    constructor() { this.port = { postMessage() {}, onmessage: null }; }
    connect() {}
  }
  class MockAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    get state() { return ctxState; }
    resume() {
      if (++resumeCalls >= 2) ctxState = 'running';
      return Promise.resolve();
    }
  }
  globalThis.AudioWorkletNode = MockWorkletNode;
  globalThis.AudioContext = MockAudioContext;
  globalThis.window = {
    AudioContext: MockAudioContext, AudioWorkletNode: MockWorkletNode,
    addEventListener(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    removeEventListener(ev, fn) { listeners.get(ev)?.delete(fn); }
  };
  try {
    const audio = createAudioDrcEngine({});
    for (let i = 0; i < 400; i++) audio.pushSample(0.2, -0.2);

    for (const fn of [...(listeners.get('keydown') || [])]) fn();
    await new Promise((r) => setTimeout(r, 15));
    assert.ok((listeners.get('keydown')?.size || 0) > 0);
    const st = audio.getStats();
    assert.strictEqual(st.mode, 'worklet');
    assert.ok(st.targetMs <= 30, `Stale targetMs=${st.targetMs}`);

    for (const fn of [...(listeners.get('keydown') || [])]) fn();
    await new Promise((r) => setTimeout(r, 15));
    assert.strictEqual(ctxState, 'running');
    assert.strictEqual(listeners.get('keydown')?.size || 0, 0);
    console.log('[PASS] P3-10: Audio Gesture Retry & Startup scriptCore');
  } finally {
    globalThis.window = prevWin;
    globalThis.AudioContext = prevAC;
    globalThis.AudioWorkletNode = prevAWN;
  }
}

async function testP3_11aAnd11bReconnectAndWasmFetch() {
  const prevWin = globalThis.window, prevDoc = globalThis.document;
  const prevLS = globalThis.localStorage, prevFetch = globalThis.fetch;
  globalThis.window = { location: { search: '?static=1', hostname: 'x.io' } };
  globalThis.document = {
    getElementById: () => ({ value: 'pass99', addEventListener() {} }),
    createElement: () => ({ style: {}, addEventListener() {} })
  };
  globalThis.localStorage = {
    getItem: () => '', setItem() {}, removeItem() {}
  };
  globalThis.fetch = async () => ({ ok: false });
  try {
    const st = { usedNostrDiscovery: true, isExternalServer: true };
    const ui = {
      roomInput: { value: 'NOVA', addEventListener() {} },
      nickInput: { value: 'P2' }, dbgWssState: { textContent: '' },
      showScreenBanner() {}, logDebug() {}, updateStatusStrip() {}
    };
    const hc = setupHybridConnectionUi(st, ui, {
      connectStandardWs: () => {}, attachCustomSocket: () => {}
    });
    hc.schedulePinggyAutoReconnect();
    hc.cancelAutoReconnect();
    hc.resetReconnectAttempts();
    const appSrc = fs.readFileSync(
      path.join(ROOT, 'public/js/console_app.mjs'), 'utf8'
    );
    assert.ok(appSrc.includes('cancelAutoReconnect'));
    assert.ok(appSrc.includes('resetReconnectAttempts'));
  } finally {
    globalThis.window = prevWin; globalThis.document = prevDoc;
    globalThis.localStorage = prevLS; globalThis.fetch = prevFetch;
  }

  const validWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0]);
  const badWasm = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0, 0]);
  let cachedCount = 0, deletedKey = null, fetchCount = 0;
  await assert.rejects(() => fetchAndValidateBrowserWasm({
    wasmUrl: 'https://x/c.wasm', cacheKey: 'K1', fileName: 'c.wasm', minBytes: 4,
    xfer: {
      getCachedRomByCrc: async () => null,
      putCachedRomByCrc: () => { cachedCount++; }
    },
    fetchImpl: async () => ({
      ok: false, status: 500, arrayBuffer: async () => validWasm.buffer
    })
  }), /500/);
  assert.strictEqual(cachedCount, 0);

  const out = await fetchAndValidateBrowserWasm({
    wasmUrl: 'https://x/c.wasm', cacheKey: 'K2', fileName: 'c.wasm', minBytes: 4,
    xfer: {
      getCachedRomByCrc: async () => ({ u8: badWasm }),
      deleteCachedRomByCrc: async (k) => { deletedKey = k; },
      putCachedRomByCrc: () => { cachedCount++; }
    },
    fetchImpl: async () => {
      fetchCount++;
      return {
        ok: true, status: 200, arrayBuffer: async () => validWasm.buffer
      };
    }
  });
  assert.strictEqual(deletedKey, 'K2');
  assert.strictEqual(fetchCount, 1);
  assert.deepStrictEqual(out, validWasm);
  console.log('[PASS] P3-11a/11b: Hybrid Reconnect & WASM Fetch/IDB Retry');
}

async function testP3_11cTo11hHardeningSuite() {
  // 11c: rom_archive finalize() catches errors cleanly
  let unhandled = null, clearedStatus = false;
  const onRej = (e) => { unhandled = e; };
  process.once('unhandledRejection', onRej);
  const stArc = {
    engine: { syncPaused: true },
    incomingRomTransfer: {
      sessionId: 'bad_gz', romName: 'x.nes', payloadEncoding: 'gzip',
      totalBytes: 4, totalChunks: 1, chunks: new Map([[0, new Uint8Array(4)]]),
      endSeen: false, receivedBytes: 4, t0: 0, lastUiAt: 0, syncState: {}
    }
  };
  const uiArc = {
    setTransferStatus: (v) => { if (v === null) clearedStatus = true; },
    logDebug() {}, showScreenBanner() {}, updateStatusStrip() {}
  };
  handleRomTransferMessage(
    { type: 'rom_chunk_end', sessionId: 'bad_gz' },
    stArc, uiArc, {}, () => {}, () => {}, () => new Uint8Array(0)
  );
  await new Promise((r) => setTimeout(r, 40));
  process.removeListener('unhandledRejection', onRej);
  assert.strictEqual(unhandled, null);
  assert.strictEqual(clearedStatus, true);
  assert.strictEqual(stArc.engine.syncPaused, false);

  // 11d: HTTP 403 short-circuit & concurrent uploadRomToServerCache race
  let f403 = 0;
  const r403 = await fetchStripedBinary('http://mock/api/room-rom', {
    fetchImpl: async () => {
      f403++;
      return { ok: false, status: 403, headers: { get: () => null } };
    }
  });
  assert.strictEqual(r403, null);
  assert.strictEqual(f403, 1);

  const prevFetch = globalThis.fetch;
  let resA = null, resB = null;
  const stUp = {
    apiBaseUrl: 'http://mock', roomCode: 'R1',
    romName: 'A.nes', romCrc32: 'AAA', romUint8: new Uint8Array(32).fill(1)
  };
  globalThis.fetch = (url) => new Promise((res) => {
    const done = () => res({ ok: true, status: 200 });
    if (String(url).includes('crc=AAA')) resA = done; else resB = done;
  });
  try {
    const pA = uploadRomToServerCache(stUp);
    stUp.romName = 'B.nes'; stUp.romCrc32 = 'BBB';
    const pB = uploadRomToServerCache(stUp);
    const activeB = stUp.roomRomUploadPromise;
    resA(); await pA;
    assert.strictEqual(stUp.roomRomUploadPromise, activeB);
    resB(); await pB;
    assert.strictEqual(stUp.roomRomUploadPromise, null);
  } finally { globalThis.fetch = prevFetch; }

  // 11e: resolveSnapshotForSync supports mid-match NES slots
  const { binaryString } = createDualControllerTestRom(0);
  const nes = new jsnes.NES({}); nes.loadROM(binaryString);
  const eng = new NesNetplayEngine(nes, { localPlayer: 1, online: true });
  eng.resetTimeline(0, 'nes_mid');
  for (let f = 0; f < 6; f++) eng.stepNetplayFrame(f & 1);
  eng.lastConfirmedRemoteFrame = 2;
  const liveH = computeDeterministicHash(nes);
  const snap = resolveSnapshotForSync(eng, eng.core);
  assert.ok(snap && snap.frame === 3 && snap.bytes?.byteLength > 100);
  assert.strictEqual(computeDeterministicHash(nes), liveH);
  const nesCheck = new jsnes.NES({}); nesCheck.loadROM(binaryString);
  assert.strictEqual(decodeNesStateBytes(nesCheck, snap.bytes), true);

  // 11f: archive_extractor.mjs must not use blocking gzipSync
  const arcSrc = fs.readFileSync(
    path.join(ROOT, 'server/archive_extractor.mjs'), 'utf8'
  );
  assert.ok(!arcSrc.includes('gzipSync'));

  // 11g: 70Hz display runs at 60 FPS (does NOT snap to 70 FPS)
  let acc = 0, ticks = 0;
  for (let i = 0; i < 700; i++) {
    const r = stepPacingAccumulator(acc, 1000 / 70, 0, true);
    acc = r.accumulatorMs;
    while (acc >= r.effectiveFrameMs) { acc -= r.effectiveFrameMs; ticks++; }
  }
  assert.ok(ticks >= 595 && ticks <= 605, `70Hz ran at ${ticks / 10} FPS`);

  // 11h: Reject fake stack SP=$FD (no JSR $20) & SP=$FF non-leaf JSR
  const mem = new Uint8Array(0x10000);
  mem.set([0xea, 0xea, 0xea, 0x4c, 0x00, 0x86], 0x8600);
  mem.set([0xea, 0x60], 0x8620);
  mem[0x01fe] = 0x02; mem[0x01ff] = 0x86;
  assert.strictEqual(
    isCpuInTightWaitLoop({ REG_PC: 0x861f, REG_SP: 0x01fd, mem }), false
  );
  mem.set([0x20, 0x00, 0x90, 0x4c, 0x00, 0x87], 0x8700);
  mem.set([0x20, 0x50, 0x91, 0xea, 0xea, 0xea], 0x9000);
  assert.strictEqual(
    isCpuInTightWaitLoop({ REG_PC: 0x86ff, REG_SP: 0x01ff, mem }), false
  );
  console.log('[PASS] P3-11c..11h: Async, 403, Race, NES Sync, 70Hz & OC');
}

async function main() {
  console.log('=== Audit Priority 3 TDD Regression Suite ===\n');
  testP3_9IceTurnValidationAndTlsFallback();
  await testP3_10AudioGestureUnlockAndStaleScriptCore();
  await testP3_11aAnd11bReconnectAndWasmFetch();
  await testP3_11cTo11hHardeningSuite();
  console.log('\nALL AUDIT PRIORITY 3 TESTS PASSED!');
}

main().catch((err) => {
  console.error('\n[FAIL] Audit P3 Suite:', err);
  process.exit(1);
});
