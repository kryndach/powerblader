// Real-Life 2P Tetris (tgm2p.zip) Controls, Bad-Internet, Spam & Audio QA Suite
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createFbneoArcadeCore } from '../src/fbneo_arcade_core.mjs';
import { createShadowRollbackHost } from '../src/shadow_rollback_host.mjs';
import {
  RollbackNetplayEngine, computeRomCrc32
} from '../src/netplay_engine.mjs';
import { extractRomFromFile } from '../server/archive_extractor.mjs';
import { createAudioDrcEngine } from '../public/js/audio_drc.mjs';
import {
  resolveSaveSlotPath, buildHumanTetrisScripts, buildButtonSpamScripts,
  TETRIS_NETWORK_PROFILES, countRegionPixelDiff
} from './tetris_scenarios.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const FRAME_MS = 1000 / 60;
const AUDIO_RATE = 48000;

function createHeadlessAudioHarness() {
  let processCb = null;
  let blockLen = 1024;
  const origCtx = globalThis.AudioContext;
  globalThis.AudioContext = class SimAudioCtx {
    constructor() {
      this.sampleRate = AUDIO_RATE;
      this.state = 'running';
      this.destination = {};
    }
    createScriptProcessor(bufSize) {
      blockLen = bufSize || 1024;
      return {
        onaudioprocess: null,
        connect() { processCb = this.onaudioprocess; }
      };
    }
  };
  const drc = createAudioDrcEngine({});
  drc.initAudio();
  globalThis.AudioContext = origCtx;

  const outL = new Float32Array(blockLen);
  const outR = new Float32Array(blockLen);
  let sampleClock = 0;
  return {
    pushSample: (l, r) => drc.pushSample(l, r),
    advanceFrameAudio() {
      sampleClock += AUDIO_RATE / 60;
      while (sampleClock >= blockLen) {
        sampleClock -= blockLen;
        processCb({
          outputBuffer: { getChannelData: (ch) => (ch === 0 ? outL : outR) }
        });
      }
    },
    getStats: () => drc.getStats()
  };
}

function createFifoChaosLink(prof, seedInit) {
  let seed = seedInit >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const queue = [];
  let lastDeliver = 0;
  const baseOneWay = prof.rttMs * 0.5;
  return {
    send(pkt, nowMs) {
      if (prof.lossPct > 0 && rand() * 100 < prof.lossPct) return;
      const jit = (rand() * 2 - 1) * prof.jitterMs;
      let at = nowMs + Math.max(8, baseOneWay + jit);
      if (prof.clumpEveryMs > 0) {
        const phase = nowMs % prof.clumpEveryMs;
        if (phase < prof.clumpHoldMs) {
          at += prof.clumpHoldMs - phase;
        }
      }
      if (at < lastDeliver) at = lastDeliver; // TCP/WSS FIFO order
      lastDeliver = at;
      queue.push({ at, pkt });
    },
    drain(nowMs, onPkt) {
      while (queue.length > 0 && queue[0].at <= nowMs) {
        onPkt(queue.shift().pkt);
      }
    },
    flushAll(onPkt) {
      while (queue.length > 0) onPkt(queue.shift().pkt);
    }
  };
}

async function runTetrisProfile(c1, c2, saveSyncState, prof) {
  const audio = createHeadlessAudioHarness();
  let fbStart1 = null, fbEnd1 = null, fbEnd2 = null;
  c1.opts.onAudioSample = (l, r) => audio.pushSample(l, r);
  c1.opts.onFrame = (fb) => {
    if (!fbStart1) fbStart1 = fb.slice();
    fbEnd1 = fb;
  };
  c2.opts.onFrame = (fb) => { fbEnd2 = fb; };

  const e1 = new RollbackNetplayEngine(c1, {
    localPlayer: 1, online: true, enableRiftPacing: false,
    inputDelayFrames: prof.delay, maxRollbackFrames: 36, saveBufferSize: 48
  });
  const e2 = new RollbackNetplayEngine(c2, {
    localPlayer: 2, online: true, enableRiftPacing: false,
    inputDelayFrames: prof.delay, maxRollbackFrames: 36, saveBufferSize: 48
  });
  const sessId = `tgm_${prof.id}`;
  const stateObj = { ...saveSyncState, sessionId: sessId };
  let shadowHost = null;
  if (prof.shadowWorker) {
    shadowHost = createShadowRollbackHost(c1);
    e1.attachShadowRollback(shadowHost);
  }
  try {
    e1.importSyncState(stateObj, { preserveLocalInputDelay: true });
    e2.importSyncState(stateObj, { preserveLocalInputDelay: true });
    if (shadowHost) {
      assert.strictEqual(
        await shadowHost.waitUntilSynced(15000), true,
        `${prof.id} Shadow Worker failed to sync`
      );
    }

    // Warm 6 clean frames so Audio DRC prebuffer fills before chaos starts
    for (let w = 0; w < 6; w++) {
      const r1 = e1.stepNetplayFrame(0), r2 = e2.stepNetplayFrame(0);
      if (r1.packetToSend) e2.receiveRemoteInputPacket(r1.packetToSend);
      if (r2.packetToSend) e1.receiveRemoteInputPacket(r2.packetToSend);
      audio.advanceFrameAudio();
    }
    fbStart1 = c1.getFrameBuffer().slice();

    const scripts = prof.mode === 'spam'
      ? buildButtonSpamScripts(prof.frames)
      : buildHumanTetrisScripts(prof.frames);
    const link12 = createFifoChaosLink(prof, 0x13579bdf);
    const link21 = createFifoChaosLink(prof, 0x2468ace1);
    const stepTimes = [];
    const wallStart = performance.now();

    for (let f = 0; f < prof.frames; f++) {
      if (shadowHost) {
        const dueMs = wallStart + f * FRAME_MS;
        const waitMs = Math.max(1, Math.floor(dueMs - performance.now()));
        await new Promise((r) => setTimeout(r, waitMs));
      }
      const nowMs = f * FRAME_MS;
      link12.drain(nowMs, (p) => e2.receiveRemoteInputPacket(p, nowMs));
      link21.drain(nowMs, (p) => e1.receiveRemoteInputPacket(p, nowMs));

      const t0 = performance.now();
      const r1 = e1.stepNetplayFrame(scripts.p1[f]);
      stepTimes.push(performance.now() - t0);
      const r2 = e2.stepNetplayFrame(scripts.p2[f]);
      audio.advanceFrameAudio();

      if (r1.packetToSend) link12.send(r1.packetToSend, nowMs);
      if (r2.packetToSend) link21.send(r2.packetToSend, nowMs);
    }

    // Drain all in-flight packets and converge both boards to exact same frame
    const endMs = prof.frames * FRAME_MS + 500;
    link12.flushAll((p) => e2.receiveRemoteInputPacket(p, endMs));
    link21.flushAll((p) => e1.receiveRemoteInputPacket(p, endMs));
    const target = Math.max(e1.currentFrame, e2.currentFrame) + 12;
    while (e1.currentFrame < target || e2.currentFrame < target) {
      if (shadowHost) await shadowHost.flush(e1, 5000);
      if (e1.currentFrame < target) {
        const p = e1.stepNetplayFrame(0).packetToSend;
        audio.advanceFrameAudio();
        if (p) e2.receiveRemoteInputPacket(p, endMs);
      }
      if (e2.currentFrame < target) {
        const p = e2.stepNetplayFrame(0).packetToSend;
        if (p) e1.receiveRemoteInputPacket(p, endMs);
      }
    }
    e2.receiveRemoteInputPacket(
      e1._buildInputPacket(e1.lastLocalScheduledFrame)
    );
    e1.receiveRemoteInputPacket(
      e2._buildInputPacket(e2.lastLocalScheduledFrame)
    );
    if (shadowHost) await shadowHost.flush(e1, 5000);
    e1.stepNetplayFrame(0);
    audio.advanceFrameAudio();
    e2.stepNetplayFrame(0);
    if (shadowHost) {
      await shadowHost.flush(e1, 5000);
      shadowHost.applyPendingAndRequestCatchup(e1);
    }

    const sorted = [...stepTimes].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const maxMs = sorted[sorted.length - 1] || 0;
    const stutters = stepTimes.filter((x) => x > 33.3).length;
    const freezes = stepTimes.filter((x) => x > 50.0).length;
    const p1WellDiff = countRegionPixelDiff(
      fbStart1, fbEnd1, 320, 22, 100, 42, 200
    );
    const p2WellDiff = countRegionPixelDiff(
      fbStart1, fbEnd1, 320, 220, 298, 42, 200
    );
    const aStats = audio.getStats();
    const sStats = shadowHost ? shadowHost.getStats() : null;
    const pitchDriftPct = Math.max(
      Math.abs(aStats.minStepRate - 1), Math.abs(aStats.maxStepRate - 1)
    ) * 100;
    const sInfo = sStats
      ? ` ShadowSwaps=${sStats.shadowSwaps} (gap=${sStats.avgGap}f)` : '';

    console.log(
      `[TETRIS ${prof.id}] ${prof.label}\n` +
        `  Frame: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms ` +
        `max=${maxMs.toFixed(1)}ms | >33ms=${stutters} >50ms=${freezes} ` +
        `RB=${e1.rollbacksTotal} Stalls=${e1.stallFrames}${sInfo}\n` +
        `  Sync:  Desync=${e1.desyncCount}/${e2.desyncCount} ` +
        `HashEq=${c1.computeHash() === c2.computeHash()} ` +
        `WellDiff(P1/P2)=${p1WellDiff}/${p2WellDiff}px\n` +
        `  Audio: RMS=${aStats.rms.toFixed(3)} Underrun=${aStats.underruns} ` +
        `Overflow=${aStats.overflows} Pitch=${pitchDriftPct.toFixed(1)}% ` +
        `MaxJump=${aStats.maxJump.toFixed(2)}`
    );

    assert.strictEqual(e1.desyncCount + e2.desyncCount, 0, `${prof.id} desync`);
    assert.strictEqual(
      c1.computeHash(), c2.computeHash(), `${prof.id} hash diff`
    );
    if (sStats) {
      assert.ok(sStats.shadowSwaps > 0, `${prof.id} expected shadowSwaps > 0`);
    }
    assert.ok(p1WellDiff > 150 && p2WellDiff > 150, `${prof.id} pieces stuck!`);
    assert.ok(aStats.rms > 0.008, `${prof.id} Tetris audio/music silent!`);
    assert.ok(
      aStats.underruns <= prof.maxUnderruns,
      `${prof.id} audio underruns=${aStats.underruns} > ${prof.maxUnderruns}`
    );
    assert.strictEqual(aStats.overflows, 0, `${prof.id} audio overflows!`);
    assert.ok(
      pitchDriftPct <= 6.0, `${prof.id} music pitch warp ${pitchDriftPct}%`
    );
    assert.ok(p95 <= prof.maxP95Ms, `${prof.id} p95=${p95.toFixed(1)}ms > cap`);
    assert.ok(
      freezes <= prof.maxFreezes, `${prof.id} >50ms freezes=${freezes}`
    );
  } finally {
    e1.destroy();
  }
}

async function main() {
  console.log(
    '=== Real-Life 2P Tetris Controls, Audio & Bad-Net QA Suite ===\n'
  );
  const romPath = path.join(ROOT_DIR, 'local', 'arcade', 'tgm2p.zip');
  if (!fs.existsSync(romPath)) {
    return console.log('[SKIP] local/arcade/tgm2p.zip not present');
  }
  const ext = extractRomFromFile(romPath);
  const romBytes = new Uint8Array(ext.romBuffer);
  const crc = computeRomCrc32(romBytes);
  // Prefer user's live 2P VS match save (2AAB0722) or matching CRC slot 1
  const savePath = resolveSaveSlotPath(ROOT_DIR, '2AAB0722', 1, [crc]);
  assert.ok(
    savePath,
    `Missing 2P Tetris save state local/saves/${crc}_slot_1.json`
  );
  const saveEntry = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  assert.ok(saveEntry?.syncState, 'Invalid Tetris save state JSON');
  console.log(
    `Loaded save: ${path.basename(savePath)} (frame #${saveEntry.frame})\n`
  );

  const c1 = await createFbneoArcadeCore({ romBytes, romName: ext.romName });
  const c2 = await createFbneoArcadeCore({ romBytes, romName: ext.romName });
  for (const prof of TETRIS_NETWORK_PROFILES) {
    await runTetrisProfile(c1, c2, saveEntry.syncState, prof);
  }
  console.log(
    `\n[PASS] All ${TETRIS_NETWORK_PROFILES.length} Real-Life 2P Tetris ` +
      'Smoothness, Shadow-Worker, Audio & Spam Gates Passed!'
  );
}

main().catch((err) => {
  console.error('\n[FAIL] Real-Life 2P Tetris QA Suite Failed:', err);
  process.exit(1);
});
