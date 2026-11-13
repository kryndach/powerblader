// Edge-Case Regression & Multi-Console Performance Benchmark Suite
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import * as jsnesModule from 'jsnes';
import {
  NesNetplayEngine, INPUT_BITS, computeDeterministicHash
} from '../src/netplay_engine.mjs';
import {
  createSegaGpgxCore, createSnes9xCore
} from '../src/sega_gpgx_core.mjs';
import {
  createFbneoArcadeCore, createMinimalArcadeTestZip
} from '../src/fbneo_arcade_core.mjs';
import { createCoopServer } from '../server/relay_server.mjs';
import { extractRomFromFile } from '../server/archive_extractor.mjs';
import {
  runTest5ReconnectAndZombieEviction,
  runTest6AudioDrcAndDeclick,
  benchmarkAndVerifyZeroGc
} from './perf_and_resilience_stages.mjs';
import {
  runTest8MidGameLobbyPopupAndDelayGuard,
  runTest9RealArcadeAndSnesSgRuRollback
} from './ui_and_arcade_regression_stages.mjs';

const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;
const LOCAL_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'local'
);

function httpGetGzip(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const headers = { 'Accept-Encoding': 'gzip, deflate' };
    const reqOpts = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers
    };
    http.get(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const rawBuf = Buffer.concat(chunks);
        const body = res.headers['content-encoding'] === 'gzip'
          ? zlib.gunzipSync(rawBuf) : rawBuf;
        resolve({
          status: res.statusCode, headers: res.headers,
          wireBytes: rawBuf.length, body
        });
      });
    }).on('error', reject);
  });
}

function settleEngines(eng1, eng2) {
  const target = Math.max(eng1.currentFrame, eng2.currentFrame) + 8;
  while (eng1.currentFrame < target || eng2.currentFrame < target) {
    if (eng1.currentFrame < target) {
      const p1 = eng1.stepNetplayFrame(0).packetToSend;
      if (p1) eng2.receiveRemoteInputPacket(p1);
    }
    if (eng2.currentFrame < target) {
      const p2 = eng2.stepNetplayFrame(0).packetToSend;
      if (p2) eng1.receiveRemoteInputPacket(p2);
    }
  }
  const f1 = eng1.lastLocalScheduledFrame;
  const f2 = eng2.lastLocalScheduledFrame;
  eng2.receiveRemoteInputPacket(eng1._buildInputPacket(f1));
  eng1.receiveRemoteInputPacket(eng2._buildInputPacket(f2));
  eng1.stepNetplayFrame(0);
  eng2.stepNetplayFrame(0);
}

function createNesPair(nesBin) {
  const nes1 = new jsnes.NES({});
  const nes2 = new jsnes.NES({});
  nes1.loadROM(nesBin);
  nes2.loadROM(nesBin);
  const eng1 = new NesNetplayEngine(nes1, {
    localPlayer: 1, online: true, inputDelayFrames: 3
  });
  const eng2 = new NesNetplayEngine(nes2, {
    localPlayer: 2, online: true, inputDelayFrames: 3
  });
  return { nes1, nes2, eng1, eng2 };
}

function testBlackoutAndOutOfOrderBurst(nesBin) {
  const { nes1, nes2, eng1, eng2 } = createNesPair(nesBin);
  const blackoutQueue = [];
  for (let f = 0; f < 160; f++) {
    const m1 = (f % 11 < 5 ? INPUT_BITS.RIGHT | INPUT_BITS.A : 0) ^ (f & 3);
    const m2 = (f % 13 < 6 ? INPUT_BITS.LEFT | INPUT_BITS.B : 0) ^ (f & 1);
    const r1 = eng1.stepNetplayFrame(m1);
    const r2 = eng2.stepNetplayFrame(m2);
    if (f >= 60 && f <= 88) {
      if ((f === 60 || f === 61) && r1.packetToSend) {
        blackoutQueue.push(r1.packetToSend);
      }
    } else if (f === 89 && r1.packetToSend) {
      eng2.receiveRemoteInputPacket(r1.packetToSend);
      eng2.receiveRemoteInputPacket(r1.packetToSend);
      while (blackoutQueue.length > 0) {
        eng2.receiveRemoteInputPacket(blackoutQueue.pop());
      }
    } else if (r1.packetToSend) {
      eng2.receiveRemoteInputPacket(r1.packetToSend);
    }
    if (r2.packetToSend) eng1.receiveRemoteInputPacket(r2.packetToSend);
  }
  settleEngines(eng1, eng2);
  assert.ok(eng2.stallFrames > 0, 'Peer should stall safely past maxAhead');
  assert.strictEqual(eng1.desyncCount + eng2.desyncCount, 0);
  assert.strictEqual(
    computeDeterministicHash(nes1), computeDeterministicHash(nes2)
  );
  console.log(
    '[PASS] Edge Case 1: 29-Packet (483ms) Blackout + Out-of-Order & ' +
      'Duplicate Packet Recovery (0 Desyncs)'
  );
}

function testRingWrapAndTurboTransitions(nesBin) {
  const { nes1, nes2, eng1, eng2 } = createNesPair(nesBin);
  const q12 = [];
  const q21 = [];
  for (let tick = 0; tick < 90; tick++) {
    const speed = tick < 25 ? 1 : tick < 50 ? 4 : tick < 70 ? 2 : 1;
    while (q12.length && q12[0].t <= tick) {
      eng2.receiveRemoteInputPacket(q12.shift().pkt);
    }
    while (q21.length && q21[0].t <= tick) {
      eng1.receiveRemoteInputPacket(q21.shift().pkt);
    }
    let p1Out = null, p2Out = null;
    for (let s = 0; s < speed; s++) {
      const opts = {
        turboSpeed: speed, skipRollback: s > 0, skipPacket: s < speed - 1
      };
      const m1 = (tick + s) % 7 < 3 ? INPUT_BITS.RIGHT | INPUT_BITS.B : 0;
      const m2 = (tick + s) % 5 < 2 ? INPUT_BITS.LEFT | INPUT_BITS.A : 0;
      const r1 = eng1.stepNetplayFrame(m1, 0, opts);
      const r2 = eng2.stepNetplayFrame(m2, 0, opts);
      if (r1.packetToSend) p1Out = r1.packetToSend;
      if (r2.packetToSend) p2Out = r2.packetToSend;
    }
    if (p1Out) q12.push({ t: tick + 2, pkt: p1Out });
    if (p2Out) q21.push({ t: tick + 2, pkt: p2Out });
  }
  while (q12.length) eng2.receiveRemoteInputPacket(q12.shift().pkt);
  while (q21.length) eng1.receiveRemoteInputPacket(q21.shift().pkt);
  settleEngines(eng1, eng2);
  assert.ok(eng1.currentFrame > 160, 'Should wrap 64-slot saveRing >2x');
  assert.strictEqual(eng1.stallFrames + eng1.desyncCount, 0);
  assert.strictEqual(
    computeDeterministicHash(nes1), computeDeterministicHash(nes2)
  );
  // Verify post-Turbo input is scheduled at +inputDelayFrames (not *4)
  const preBtnFrame = eng1.currentFrame;
  eng1.stepNetplayFrame(INPUT_BITS.START, 0, { turboSpeed: 1 });
  assert.strictEqual(
    eng1.getLocalInputAt(preBtnFrame + eng1.inputDelayFrames), INPUT_BITS.START
  );
  // Verify Turbo maxAhead caps lead at saveBufferSize - 6 (no 360f overflow)
  for (let i = 0; i < 80; i++) {
    eng1.stepNetplayFrame(0, 0, { turboSpeed: 4, skipPacket: true });
  }
  const turboLead = eng1.currentFrame - eng1.lastConfirmedRemoteFrame;
  assert.ok(
    turboLead <= eng1.saveBufferSize - 5,
    `Turbo lead (${turboLead}f) must not exceed saveRing capacity`
  );
  // Verify HBlank triggerRendering ($2001=0 at curX>=256) flushes current row
  const ppu = nes1.ppu;
  ppu.f_bgVisibility = 1;
  ppu.scanline = 250;
  ppu.curX = 339;
  ppu.lastRenderedScanline = 229;
  ppu.scanlineAlreadyRendered = false;
  ppu.validTileData = true;
  ppu.scantile = new Array(32).fill({
    opaque: new Array(8).fill(false),
    pix: new Array(64).fill(3)
  });
  ppu.attrib = new Array(32).fill(0);
  ppu.imgPalette = new Array(16).fill(0x224466);
  ppu.buffer.fill(0);
  ppu.firstWrite = true;
  ppu.triggerRendering();
  assert.strictEqual(
    ppu.buffer[230 * 256 + 10], 0x224466,
    'HBlank triggerRendering must composite current scanline (TMNT3 HUD y=230)'
  );
  console.log(
    '[PASS] Edge Case 2: 64-Slot SaveRing Wraparound, Dynamic Turbo & ' +
      `TMNT3 HBlank HUD Flush (${eng1.currentFrame}f, 0 Stalls, 0 Desyncs)`
  );
}

async function testSnesAndArcadePreSyncRollback() {
  const snesRom = new Uint8Array(0x8000);
  snesRom.set([0x20, 0, 5, 0, 0, 0, 0, 255, 255, 0, 0], 0x7fd5);
  snesRom.set([0x00, 0x80], 0x7ffc);
  snesRom.set([0x78, 0x18, 0xfb, 0xee, 0x00, 0x00, 0x4c, 0x03, 0x80], 0);

  const snes1 = await createSnes9xCore({ romBytes: snesRom, romName: 'A.sfc' });
  const origProc = globalThis.process;
  delete globalThis.process;
  const snes2 = await createSnes9xCore({ romBytes: snesRom, romName: 'B.sfc' });
  globalThis.process = origProc;

  const se1 = new NesNetplayEngine(snes1, { localPlayer: 1, online: true });
  const se2 = new NesNetplayEngine(snes2, { localPlayer: 2, online: true });
  const sq12 = [], sq21 = [];
  for (let f = 0; f < 45; f++) {
    while (sq12.length && sq12[0].d <= f) {
      se2.receiveRemoteInputPacket(sq12.shift().p);
    }
    while (sq21.length && sq21[0].d <= f) {
      se1.receiveRemoteInputPacket(sq21.shift().p);
    }
    const r1 = se1.stepNetplayFrame(f % 4 < 2 ? INPUT_BITS.B : 0);
    const r2 = se2.stepNetplayFrame(f % 5 < 2 ? INPUT_BITS.A : 0);
    if (r1.packetToSend) sq12.push({ d: f + 3, p: r1.packetToSend });
    if (r2.packetToSend) sq21.push({ d: f + 3, p: r2.packetToSend });
  }
  while (sq12.length) se2.receiveRemoteInputPacket(sq12.shift().p);
  while (sq21.length) se1.receiveRemoteInputPacket(sq21.shift().p);
  settleEngines(se1, se2);
  assert.strictEqual(snes1.computeHash(), snes2.computeHash());
  assert.strictEqual(se1.desyncCount, 0);

  const arcZip = createMinimalArcadeTestZip();
  const arcOpts = { romBytes: arcZip, romName: 'minivadr.zip' };
  const arc1 = await createFbneoArcadeCore(arcOpts);
  const arc2 = await createFbneoArcadeCore(arcOpts);
  const ae1 = new NesNetplayEngine(arc1, { localPlayer: 1, online: true });
  const ae2 = new NesNetplayEngine(arc2, { localPlayer: 2, online: true });
  for (let f = 0; f < 25; f++) {
    const r1 = ae1.stepNetplayFrame(f % 3 === 0 ? INPUT_BITS.A : 0);
    const r2 = ae2.stepNetplayFrame(f % 4 === 0 ? INPUT_BITS.LEFT : 0);
    if (f % 3 === 2) {
      if (r1.packetToSend) ae2.receiveRemoteInputPacket(r1.packetToSend);
      if (r2.packetToSend) ae1.receiveRemoteInputPacket(r2.packetToSend);
    }
  }
  settleEngines(ae1, ae2);
  assert.strictEqual(arc1.computeHash(), arc2.computeHash());
  const memfsBufBefore = arc1.getMemfsStateView().buffer;
  arc1.stepFrame(INPUT_BITS.B, 0, true);
  const memfsBufAfter = arc1.getMemfsStateView().buffer;
  assert.strictEqual(
    memfsBufAfter, memfsBufBefore,
    'FBNeo MEMFS stateNode.contents must reuse same ArrayBuffer in-place (0-GC)'
  );
  const syncObj = ae1.exportSyncState();
  assert.ok(syncObj.rawStateB64.length < arc1.saveStateBytes().length);
  ae2.importSyncState(syncObj);
  assert.strictEqual(arc1.computeHash(), arc2.computeHash());
  console.log(
    '[PASS] Edge Case 3: SNES & FBNeo Arcade Pre-Sync Rollback ' +
      'Determinism + ZRLE State Compression Verified'
  );
  return { snesCore: snes1, arcMinCore: arc1 };
}

async function testHttpGzipRomAndWasmTransfer() {
  const app = createCoopServer({ logAccess: false });
  const port = await app.listen(0, '127.0.0.1');
  try {
    const base = `http://127.0.0.1:${port}`;
    const wasmRes = await httpGetGzip(
      `${base}/vendor/genesis_plus_gx_libretro.wasm`
    );
    assert.strictEqual(wasmRes.headers['content-encoding'], 'gzip');
    assert.ok(wasmRes.headers['cache-control']?.includes('max-age=86400'));
    const ratio = wasmRes.body.length / wasmRes.wireBytes;
    assert.ok(ratio > 2.5, `Expected WASM gzip ratio >2.5x, got ${ratio}`);

    const listRes = await httpGetGzip(`${base}/api/local-roms`);
    const listObj = JSON.parse(listRes.body.toString('utf8'));
    if (listObj.roms?.length > 0) {
      const r =
        listObj.roms.find((x) => x.system === 'sega_md') || listObj.roms[0];
      const romRes = await httpGetGzip(
        `${base}/api/local-rom?name=${encodeURIComponent(r.name)}`
      );
      assert.strictEqual(romRes.headers['content-encoding'], 'gzip');
      const rawLen = Number(romRes.headers['x-raw-length']);
      assert.strictEqual(rawLen, romRes.body.length);
      assert.ok(romRes.wireBytes < romRes.body.length);
    }
    console.log(
      '[PASS] Edge Case 4: HTTP Gzip Transfer & Cache Headers ' +
        `(WASM ${(wasmRes.body.length / 1048576).toFixed(2)}MB -> ` +
        `${(wasmRes.wireBytes / 1048576).toFixed(2)}MB, ${ratio.toFixed(1)}x)`
    );
  } finally {
    await app.close();
  }
}

async function main() {
  console.log('=== Edge-Case Regression & Performance Benchmarks ===\n');
  const nesDir = fs.existsSync(path.join(LOCAL_DIR, 'nes'))
    ? path.join(LOCAL_DIR, 'nes') : LOCAL_DIR;
  const files = fs.readdirSync(nesDir);
  const tmntFile = files.find((f) => f.toLowerCase().includes('turtles')) ||
    files.find((f) => f.endsWith('.nes'));
  const nesBin = fs.readFileSync(path.join(nesDir, tmntFile), 'binary');

  testBlackoutAndOutOfOrderBurst(nesBin);
  testRingWrapAndTurboTransitions(nesBin);
  const { snesCore } = await testSnesAndArcadePreSyncRollback();
  await testHttpGzipRomAndWasmTransfer();
  await runTest5ReconnectAndZombieEviction();
  runTest6AudioDrcAndDeclick();
  runTest8MidGameLobbyPopupAndDelayGuard();
  const arcCore = await runTest9RealArcadeAndSnesSgRuRollback(
    LOCAL_DIR, createMinimalArcadeTestZip()
  );
  console.log(
    '\n--- Multi-Console Zero-GC & 60 FPS (16.67ms) Frame-Budget Benchmarks ---'
  );
  const nesCore = new jsnes.NES({});
  nesCore.loadROM(nesBin);
  benchmarkAndVerifyZeroGc('NES (TMNT III)', nesCore, true, 240);
  const segaDir = path.join(LOCAL_DIR, 'sega');
  if (fs.existsSync(segaDir) && fs.readdirSync(segaDir).length > 0) {
    const f = fs.readdirSync(segaDir)[0];
    const { romName, romBuffer } = extractRomFromFile(path.join(segaDir, f));
    const segaCore = await createSegaGpgxCore({
      romBytes: new Uint8Array(romBuffer), romName
    });
    benchmarkAndVerifyZeroGc('Sega MD (Sonic 3&K)', segaCore, false, 180);
  }
  benchmarkAndVerifyZeroGc('SNES (Snes9x WASM)', snesCore, false, 20);
  benchmarkAndVerifyZeroGc('Arcade (FBNeo TGM2+)', arcCore, false, 30);
  console.log('\nALL 9 EDGE-CASE & ZERO-GC BENCHMARK GATES PASSED!');
}

main().catch((err) => {
  console.error('\n[FAIL] Benchmark / Edge-Case Suite Failed:', err);
  process.exit(1);
});
