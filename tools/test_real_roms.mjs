/**
 * @fileoverview Real NES ROMs & Non-NES Netcode Optimization Test Suite.
 *
 * Line width <= 80 chars, file size <= 350 lines.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import * as jsnesModule from 'jsnes';
import {
  NesNetplayEngine, INPUT_BITS, computeDeterministicHash, computeRomCrc32,
  formatHex32, saveFastState, loadFastState
} from '../src/netplay_engine.mjs';
import {
  runStage3StripingAndDedup, runStage4AsymmetricDelay,
  runStage5PowerBladeHudAndAudio
} from './real_rom_advanced_stages.mjs';
import { writeSyntheticNesRomSet } from './test_rom_builder_tables.mjs';
import { extractRomFromFile } from '../server/archive_extractor.mjs';
import { createSegaGpgxCore } from '../src/sega_gpgx_core.mjs';

const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_BASE_DIR = path.resolve(__dirname, '..', 'local');
const LOCAL_SEGA_DIR = path.join(LOCAL_BASE_DIR, 'sega');

function inspectInesHeader(u8) {
  const prgKB = (u8[4] || 0) * 16;
  const chrKB = (u8[5] || 0) * 8;
  const mapper = ((u8[6] || 0) >> 4) | ((u8[7] || 0) & 0xf0);
  return { prgKB, chrKB, mapper, hasChrRam: chrKB === 0 };
}

async function runRealRomsSuite() {
  console.log('=== NES & Multi-Console ROM Netcode Optimization Suite ===\n');
  const realDir = fs.existsSync(path.join(LOCAL_BASE_DIR, 'nes'))
    ? path.join(LOCAL_BASE_DIR, 'nes') : LOCAL_BASE_DIR;
  let romDir = realDir, tmpSynDir = null;
  let romFiles = fs.existsSync(realDir)
    ? fs.readdirSync(realDir).filter((f) => f.toLowerCase().endsWith('.nes'))
      .sort() : [];
  if (romFiles.length === 0) {
    tmpSynDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_syn_roms_'));
    romDir = tmpSynDir;
    romFiles = writeSyntheticNesRomSet(tmpSynDir);
    console.log('[INFO] No local/ ROMs found — running on synthetic ROMs.');
  }
  const LOCAL_ROMS_DIR = romDir;
  assert.ok(romFiles.length >= 3);
  try {

  // Stage 1: Verify O(1) Headless PPU Bit-Exactness & Savestate Round-Trip
  for (const fileName of romFiles) {
    const fullPath = path.join(LOCAL_ROMS_DIR, fileName);
    const buf = fs.readFileSync(fullPath);
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const crc = computeRomCrc32(u8);
    const hdr = inspectInesHeader(u8);
    const bin = buf.toString('binary');

    const nesNormal = new jsnes.NES({});
    const nesHeadless = new jsnes.NES({});
    nesNormal.loadROM(bin);
    nesHeadless.loadROM(bin);

    const engOpts = { localPlayer: 1, online: true };
    const engNormal = new NesNetplayEngine(nesNormal, engOpts);
    const engHeadless = new NesNetplayEngine(nesHeadless, engOpts);

    let normalMs = 0;
    let headlessMs = 0;
    for (let f = 0; f < 240; f++) {
      const p1 =
        (f % 45 === 10 ? INPUT_BITS.START : 0) |
        (f > 100 && (f >> 3) % 2 === 0 ? INPUT_BITS.RIGHT | INPUT_BITS.A : 0);
      const p2 =
        (f % 45 === 25 ? INPUT_BITS.START : 0) |
        (f > 100 && (f >> 3) % 2 === 1 ? INPUT_BITS.LEFT | INPUT_BITS.B : 0);

      if (f === 120) {
        const slot = engNormal.saveRing[0];
        saveFastState(nesNormal, slot, 120);
        for (let k = 0; k < 5; k++) nesNormal.frame();
        loadFastState(nesNormal, slot);
      }

      const t0 = performance.now();
      nesNormal.ppu._headlessFrame = false;
      engNormal.stepNetplayFrame(p1, p2);
      normalMs += performance.now() - t0;

      const t1 = performance.now();
      nesHeadless.ppu._headlessFrame = true;
      engHeadless.stepNetplayFrame(p1, p2);
      nesHeadless.ppu._headlessFrame = false;
      headlessMs += performance.now() - t1;
    }

    const hashNormal = formatHex32(computeDeterministicHash(nesNormal));
    const hashHeadless = formatHex32(computeDeterministicHash(nesHeadless));
    assert.strictEqual(hashHeadless, hashNormal);
    assert.ok(nesNormal.ppu.vramMem.subarray(0x3f00, 0x3f20).some((v) => v));
    const avgNormalMs = normalMs / 240;
    const avgHeadlessMs = headlessMs / 240;
    assert.ok(avgNormalMs < 5.0);

    console.log(
      `[PASS] Stage 1 (${fileName}): CRC=${crc} Mapper=${hdr.mapper} ` +
        `CHR-RAM=${hdr.hasChrRam} | Normal=${avgNormalMs.toFixed(2)}ms/f, ` +
        `Headless=${avgHeadlessMs.toFixed(2)}ms/f | Hash=${hashNormal}`
    );
  }

  // Stage 2: Pinggy 250ms + TCP Clumping (Real Prod Config: 0f & 2f Delay)
  let romIdx = 0;
  for (const fileName of romFiles) {
    const delayCfg = (romIdx++ & 1) === 0 ? 2 : 0;
    const fullPath = path.join(LOCAL_ROMS_DIR, fileName);
    const bin = fs.readFileSync(fullPath).toString('binary');

    let p1VisualFrames = 0;
    let lastVisualFirstPixel = 0;
    const nes1 = new jsnes.NES({
      onFrame: (fb) => {
        p1VisualFrames++;
        lastVisualFirstPixel = fb[0];
      }
    });
    const nes2 = new jsnes.NES({});
    nes1.loadROM(bin);
    nes2.loadROM(bin);

    const eng1 = new NesNetplayEngine(nes1, {
      localPlayer: 1, online: true, inputDelayFrames: delayCfg,
      enableRiftPacing: false, enableVisualSmoothing: false
    });
    const eng2 = new NesNetplayEngine(nes2, {
      localPlayer: 2, online: true, inputDelayFrames: delayCfg,
      enableRiftPacing: false, enableVisualSmoothing: false
    });

    const q12 = [];
    const q21 = [];
    let nextFlush12 = 120;
    let nextFlush21 = 110;

    for (let tick = 0; tick < 300; tick++) {
      const nowMs = tick * 16.667;

      while (q12.length > 0 && q12[0].deliverAt <= nowMs) {
        eng2.receiveRemoteInputPacket(q12.shift().pkt, nowMs);
      }
      while (q21.length > 0 && q21[0].deliverAt <= nowMs) {
        eng1.receiveRemoteInputPacket(q21.shift().pkt, nowMs);
      }

      const p1Mask =
        (tick % 50 === 12 ? INPUT_BITS.START : 0) |
        (tick > 80 && Math.floor(tick / 7) % 2 === 0
          ? INPUT_BITS.RIGHT | INPUT_BITS.B : 0) |
        (tick > 160 && Math.floor(tick / 11) % 3 === 0
          ? INPUT_BITS.A | INPUT_BITS.UP : 0);
      const p2Mask =
        (tick % 50 === 28 ? INPUT_BITS.START : 0) |
        (tick > 80 && Math.floor(tick / 6) % 2 === 0
          ? INPUT_BITS.LEFT | INPUT_BITS.A : 0) |
        (tick > 160 && Math.floor(tick / 9) % 3 === 0
          ? INPUT_BITS.B | INPUT_BITS.DOWN : 0);
      const r1 = eng1.stepNetplayFrame(p1Mask);
      const r2 = eng2.stepNetplayFrame(p2Mask);
      if (r1.packetToSend) {
        if (nowMs + 125 > nextFlush12) {
          nextFlush12 = nowMs + 125 + (tick % 4 === 0 ? 55 : 0);
        }
        q12.push({ deliverAt: nextFlush12, pkt: r1.packetToSend });
      }
      if (r2.packetToSend) {
        if (nowMs + 115 > nextFlush21) {
          nextFlush21 = nowMs + 115 + (tick % 2 === 0 ? 20 : 0);
        }
        q21.push({ deliverAt: nextFlush21, pkt: r2.packetToSend });
      }
    }

    let drainNow = 300 * 16.667 + 300;
    while (q12.length) eng2.receiveRemoteInputPacket(q12.shift().pkt, drainNow);
    while (q21.length) eng1.receiveRemoteInputPacket(q21.shift().pkt, drainNow);

    const targetFinal = Math.max(eng1.currentFrame, eng2.currentFrame) + 12;
    while (eng1.currentFrame < targetFinal || eng2.currentFrame < targetFinal) {
      drainNow += 16.667;
      if (eng1.currentFrame < targetFinal) {
        const p = eng1.stepNetplayFrame(0).packetToSend;
        if (p) eng2.receiveRemoteInputPacket(p, drainNow);
      }
      if (eng2.currentFrame < targetFinal) {
        const p = eng2.stepNetplayFrame(0).packetToSend;
        if (p) eng1.receiveRemoteInputPacket(p, drainNow);
      }
    }
    const fin1 = eng1._buildInputPacket(eng1.lastLocalScheduledFrame);
    const fin2 = eng2._buildInputPacket(eng2.lastLocalScheduledFrame);
    eng2.receiveRemoteInputPacket(fin1, drainNow + 20);
    eng1.receiveRemoteInputPacket(fin2, drainNow + 20);
    const s1 = eng1.stepNetplayFrame(0).packetToSend;
    const s2 = eng2.stepNetplayFrame(0).packetToSend;
    if (s1) eng2.receiveRemoteInputPacket(s1, drainNow + 30);
    if (s2) eng1.receiveRemoteInputPacket(s2, drainNow + 30);

    const t1 = eng1.getTelemetry();
    const t2 = eng2.getTelemetry();
    const finalHash1 = formatHex32(computeDeterministicHash(nes1));
    const finalHash2 = formatHex32(computeDeterministicHash(nes2));

    assert.strictEqual(t1.desyncCount, 0);
    assert.strictEqual(t2.desyncCount, 0);
    assert.strictEqual(finalHash1, finalHash2);
    assert.ok(t2.rxClumpFrames > 0);
    assert.ok(p1VisualFrames > 220 && typeof lastVisualFirstPixel === 'number');
    assert.strictEqual(t1.smoothedFramesCount, 0);

    console.log(
      `[PASS] Stage 2 Pinggy (${fileName}, ${delayCfg}f): ` +
        `RB P1=${t1.rollbacksTotal}(max=${t1.maxRollbackDepthSeen}f), ` +
        `P2=${t2.rollbacksTotal}(clump=${t2.rxClumpFrames}f) | 0 Desyncs`
    );
  }

  await runStage3StripingAndDedup();
  runStage4AsymmetricDelay(romFiles, LOCAL_ROMS_DIR);
  runStage5PowerBladeHudAndAudio(romFiles, LOCAL_ROMS_DIR);

  // Stage 6: Chip 'n Dale 2 Anti-Lag Overclock & Save-Slot Sync Verification
  const cndFile = romFiles.find((f) => f.toLowerCase().includes('chip'));
  if (cndFile) {
    const bin = fs.readFileSync(path.join(LOCAL_ROMS_DIR, cndFile), 'binary');
    const nes1 = new jsnes.NES({});
    const nes2 = new jsnes.NES({});
    nes1.loadROM(bin);
    nes2.loadROM(bin);
    const eng1 = new NesNetplayEngine(nes1, { localPlayer: 1, online: true });
    const eng2 = new NesNetplayEngine(nes2, { localPlayer: 2, online: true });
    assert.strictEqual(nes1.ppu._overclockEnabled, false);
    nes1.ppu._overclockEnabled = nes2.ppu._overclockEnabled = true;

    let savedSlot1 = null;
    for (let f = 0; f < 650; f++) {
      const m1 = (f % 40 === 10 ? INPUT_BITS.START : 0) | INPUT_BITS.RIGHT;
      const m2 = (f % 40 === 20 ? INPUT_BITS.START : 0) | INPUT_BITS.A;
      const r1 = eng1.stepNetplayFrame(m1);
      const r2 = eng2.stepNetplayFrame(m2);
      if (r1.packetToSend) eng2.receiveRemoteInputPacket(r1.packetToSend);
      if (r2.packetToSend) eng1.receiveRemoteInputPacket(r2.packetToSend);
      if (f === 320) savedSlot1 = eng1.exportSyncState();
    }
    assert.strictEqual(nes1.ppu._hasTightWaitLoop, true);
    assert.strictEqual(nes1.ppu._noSpriteLimit, true);
    assert.ok(savedSlot1 && savedSlot1.frame === 321);
    const resumeState = { ...savedSlot1, sessionId: 'slot1_loaded' };
    eng1.importSyncState(resumeState, { preserveLocalInputDelay: true });
    eng2.importSyncState(resumeState, { preserveLocalInputDelay: true });
    assert.strictEqual(nes1.ppu._overclockEnabled, true);
    assert.strictEqual(
      computeDeterministicHash(nes1), computeDeterministicHash(nes2)
    );
    let turboPkts = 0, p1Out = null, p2Out = null;
    for (let tick = 0; tick < 15; tick++) {
      p1Out = p2Out = null;
      for (let s = 0; s < 4; s++) {
        const opts = { turboSpeed: 4, skipRollback: s > 0, skipPacket: s < 3 };
        const r1 = eng1.stepNetplayFrame(INPUT_BITS.RIGHT, 0, opts);
        const r2 = eng2.stepNetplayFrame(INPUT_BITS.LEFT, 0, opts);
        if (r1.packetToSend) { turboPkts++; p1Out = r1.packetToSend; }
        if (r2.packetToSend) p2Out = r2.packetToSend;
      }
      if (p1Out) eng2.receiveRemoteInputPacket(p1Out);
      if (p2Out) eng1.receiveRemoteInputPacket(p2Out);
    }
    assert.strictEqual(turboPkts, 15);
    assert.strictEqual(eng1.stallFrames, 0);
    const h1 = formatHex32(computeDeterministicHash(nes1));
    assert.strictEqual(h1, formatHex32(computeDeterministicHash(nes2)));
    console.log(
      `[PASS] Stage 6 (${cndFile}): Anti-Lag Overclock, Online 4x Turbo ` +
        `(${turboPkts} pkts/15 ticks, 0 stalls) & Save-Slot Sync (Hash=${h1})`
    );
  }

  // Stage 7: Real Sega Genesis ROM (Sonic 3 & Knuckles) Rollback & State Sync
  if (fs.existsSync(LOCAL_SEGA_DIR)) {
    const segaFiles = fs.readdirSync(LOCAL_SEGA_DIR).sort();
    if (segaFiles.length > 0) {
      const { romName, romBuffer } = extractRomFromFile(
        path.join(LOCAL_SEGA_DIR, segaFiles[0])
      );
      const u8 = new Uint8Array(romBuffer);
      let s1Frames = 0;
      const s1 = await createSegaGpgxCore({
        romBytes: u8, romName, onFrame: () => s1Frames++
      });
      const origProc = globalThis.process;
      delete globalThis.process;
      const s2 = await createSegaGpgxCore({ romBytes: u8, romName });
      globalThis.process = origProc;
      const e1 = new NesNetplayEngine(s1, { localPlayer: 1, online: true });
      const e2 = new NesNetplayEngine(s2, { localPlayer: 2, online: true });
      const q12 = [], q21 = [];
      const drain = (q, eng, lim) => {
        while (q.length && q[0].d <= lim) {
          eng.receiveRemoteInputPacket(q.shift().p);
        }
      };
      for (let f = 0; f < 135; f++) {
        drain(q12, e2, f); drain(q21, e1, f);
        const r1 = e1.stepNetplayFrame(f % 45 < 5 ? INPUT_BITS.START : 0);
        const r2 = e2.stepNetplayFrame(f % 53 < 5 ? INPUT_BITS.A : 0);
        if (r1.packetToSend) q12.push({ d: f + 4, p: r1.packetToSend });
        if (r2.packetToSend) q21.push({ d: f + 4, p: r2.packetToSend });
      }
      drain(q12, e2, 999); drain(q21, e1, 999);
      e1.stepNetplayFrame(0); e2.stepNetplayFrame(0);
      assert.strictEqual(e1.desyncCount + e2.desyncCount, 0);
      assert.strictEqual(s1.computeHash(), s2.computeHash());
      e2.importSyncState(e1.exportSyncState());
      assert.strictEqual(s1.computeHash(), s2.computeHash());
      assert.ok(s1Frames > 120);
      const sHash = formatHex32(s1.computeHash());
      console.log(
        `[PASS] Stage 7 (${romName}): 320x224 Sega Genesis Rollback ` +
          `Determinism (0 Desyncs) & State Sync (Hash=${sHash})`
      );
    }
  }

  console.log('\nALL NES & SEGA ROM NETCODE TESTS PASSED!');
  } finally {
    if (tmpSynDir) {
      try { fs.rmSync(tmpSynDir, { recursive: true, force: true }); } catch {}
    }
  }
}

runRealRomsSuite().catch((err) => {
  console.error('\n[FAIL] Real ROMs Test Suite Failed:', err);
  process.exit(1);
});
