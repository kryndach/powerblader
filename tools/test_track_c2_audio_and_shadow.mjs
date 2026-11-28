// TDD Verification Suite for Track C2: AudioWorklet & Universal Shadow Worker
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as jsnesMod from 'jsnes';
import {
  NesNetplayEngine, INPUT_BITS
} from '../src/netplay_engine.mjs';
import {
  createShadowRollbackHost, shouldAttachShadowWorker
} from '../src/shadow_rollback_host.mjs';
import {
  createSegaGpgxCore, createSnes9xCore, resampleStereoS16Linear
} from '../src/sega_gpgx_core.mjs';
import { createAudioDrcEngine } from '../public/js/audio_drc.mjs';
import { createDrcAudioCore } from '../public/js/audio_worklet_processor.mjs';
import { extractRomFromZipBuffer } from '../server/archive_extractor.mjs';
import { createDualControllerTestRom } from './test_rom_builder_tables.mjs';

const jsnes = jsnesMod.NES ? jsnesMod : jsnesMod.default;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function testC2aAudioWorkletAndDynamicRate() {
  for (const outRate of [48000, 44100]) {
    const drc = createDrcAudioCore({ outSampleRate: outRate, mode: 'worklet' });
    assert.ok(
      drc.targetMs >= 48 && drc.targetMs <= 64,
      `Worklet targetMs=${drc.targetMs} must be in 48..64ms jitter-safe band`
    );
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    const totalFrames = 120; // 2.0 seconds at 60 Hz
    const samplesPerFrame = 800; // 48000 / 60
    const quantaPerFrame = outRate / 60 / 128;
    let qAcc = 0, sampleIdx = 0;

    for (let f = 0; f < totalFrames; f++) {
      const chunkL = new Float32Array(samplesPerFrame);
      const chunkR = new Float32Array(samplesPerFrame);
      for (let i = 0; i < samplesPerFrame; i++, sampleIdx++) {
        const v = Math.sin((2 * Math.PI * 440 * sampleIdx) / 48000) * 0.5;
        chunkL[i] = v;
        chunkR[i] = v;
      }
      drc.pushChunk(chunkL, chunkR);
      qAcc += quantaPerFrame;
      while (qAcc >= 1) {
        drc.renderBlock(outL, outR);
        qAcc -= 1;
      }
    }
    const st = drc.getStats();
    assert.strictEqual(
      st.underruns, 0, `Rate ${outRate}Hz had ${st.underruns} underruns!`
    );
    assert.strictEqual(
      st.overflows, 0, `Rate ${outRate}Hz had ${st.overflows} overflows!`
    );
    assert.ok(st.rms > 0.2, `Rate ${outRate}Hz RMS too low: ${st.rms}`);
    const expectedBase = 48000 / outRate;
    assert.ok(
      st.minStepRate >= expectedBase * 0.98 &&
      st.maxStepRate <= expectedBase * 1.02 &&
      (st.maxStepJump || 0) <= 0.005,
      `Rate ${outRate}Hz stepRate [${st.minStepRate}, ${st.maxStepRate}] ` +
        `jump=${st.maxStepJump} did not track base ${expectedBase.toFixed(4)}`
    );
  }

  // Verify createAudioDrcEngine initializes AudioWorklet & flushes bootQueue
  let workletLoadedUrl = null;
  let workletNodeCreated = false;
  const postedMsgs = [];
  const prevAC = globalThis.AudioContext;
  const prevAWN = globalThis.AudioWorkletNode;
  try {
    globalThis.AudioWorkletNode = class MockWorkletNode {
      constructor(_ctx, name, opts) {
        workletNodeCreated = name === 'netplay-drc-processor' && Boolean(opts);
        this.port = {
          postMessage(m) { postedMsgs.push(m); },
          onmessage: null
        };
      }
      connect() {}
    };
    globalThis.AudioContext = class MockAudioCtx {
      constructor() {
        this.sampleRate = 44100;
        this.state = 'running';
        this.destination = {};
        this.audioWorklet = {
          addModule: async (url) => { workletLoadedUrl = String(url); }
        };
      }
      resume() {}
    };
    const eng = createAudioDrcEngine({});
    eng.initAudio();
    for (let i = 0; i < 600; i++) eng.pushSample(0.25, -0.25);
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(
      workletLoadedUrl && workletLoadedUrl.includes('audio_worklet_processor'),
      `Expected AudioWorklet addModule(), got: ${workletLoadedUrl}`
    );
    assert.strictEqual(
      workletNodeCreated, true,
      'AudioWorkletNode was never constructed after addModule() resolved!'
    );
    const chunkMsgs = postedMsgs.filter((m) => m?.type === 'chunk');
    assert.ok(
      chunkMsgs.length >= 2,
      `Expected bootQueue flush (>=2 chunks), got ${chunkMsgs.length}`
    );
  } finally {
    globalThis.AudioContext = prevAC;
    globalThis.AudioWorkletNode = prevAWN;
  }
  console.log('[PASS] C2a-1: AudioWorklet DRC (48/44.1kHz, 60ms jitter-safe)');
}

function testC2aLinearAudioResampling() {
  // Ramp [0, 8192, 16384, 24576] resampled 4 -> 8 frames must interpolate!
  const s16 = new Int16Array([
    0, 0, 8192, -8192, 16384, -16384, 24576, -24576
  ]);
  const outL = [], outR = [];
  resampleStereoS16Linear(s16, 0, 4, 8, (l, r) => {
    outL.push(l);
    outR.push(r);
  });
  assert.strictEqual(outL.length, 8);
  // Sample 1 is at pos=0.5 between 0 and 8192/32768=0.25 -> must be ~0.125!
  assert.ok(
    Math.abs(outL[1] - 0.125) < 0.01 && Math.abs(outR[1] + 0.125) < 0.01,
    `Expected linear midpoint +/-0.125, got L=${outL[1]} R=${outR[1]}`
  );
  console.log('[PASS] C2a-2: Linear Interpolation Audio Resampling Verified');
}

async function runUniversalShadowScenario(label, core, refCore, frames = 80) {
  const eng = new NesNetplayEngine(core, {
    localPlayer: 1, online: true, inputDelayFrames: 1, maxRollbackFrames: 40
  });
  const refEng = new NesNetplayEngine(refCore, {
    localPlayer: 1, online: false, inputDelayFrames: 0
  });
  const host = createShadowRollbackHost(core);
  eng.attachShadowRollback(host);
  eng.resetTimeline(0, `c2_${label}`);
  refEng.resetTimeline(0, `c2_${label}`);

  const synced = await host.waitUntilSynced(15000);
  assert.strictEqual(synced, true, `${label}: Shadow Worker failed to sync!`);

  const delayFrames = 7;
  const p2Input = (f) => ((f % 14) < 5 ? INPUT_BITS.RIGHT : INPUT_BITS.A);
  const p1Input = (f) => ((f % 12) < 4 ? INPUT_BITS.LEFT : INPUT_BITS.B);

  for (let f = 0; f < frames; f++) {
    eng.stepNetplayFrame(p1Input(f));
    const arrived = f - delayFrames;
    if (arrived >= 0 && arrived % 2 === 0) {
      const inputs = [];
      for (let k = Math.max(0, arrived - 7); k <= arrived; k++) {
        inputs.push(p2Input(k));
      }
      eng.receiveRemoteInputPacket({
        type: 'netplay_input', sessionId: `c2_${label}`, player: 2,
        startFrame: arrived, inputs: inputs.reverse()
      });
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  const finalInputs = [];
  for (let k = frames - 1; k >= Math.max(0, frames - 20); k--) {
    finalInputs.push(p2Input(k));
  }
  eng.receiveRemoteInputPacket({
    type: 'netplay_input', sessionId: `c2_${label}`, player: 2,
    startFrame: frames - 1, inputs: finalInputs
  });
  await host.flush(eng, 10000);
  eng.stepNetplayFrame(0);
  await host.flush(eng, 10000);
  eng.stepNetplayFrame(0);

  for (let f = 0; f < eng.currentFrame; f++) {
    refEng.stepNetplayFrame(
      eng.getPlayerInput(1, f), eng.getPlayerInput(2, f)
    );
  }
  const st = host.getStats();
  const hShadow = eng.core.computeHash();
  const hRef = refEng.core.computeHash();
  host.destroy();
  core.destroy?.();
  refCore.destroy?.();

  assert.ok(
    st.shadowSwaps > 0,
    `${label}: Expected shadowSwaps > 0, got ${JSON.stringify(st)}`
  );
  assert.strictEqual(
    hShadow, hRef,
    `${label}: Shadow Worker hash mismatch! got=${hShadow} exp=${hRef}`
  );
  return st;
}

async function testC2bUniversalShadowWorker() {
  for (const sys of ['arcade', 'snes', 'sega_md', 'sega_sms']) {
    assert.strictEqual(
      shouldAttachShadowWorker(sys), true,
      `shouldAttachShadowWorker(${sys}) must return true for WASM cores`
    );
  }
  assert.strictEqual(
    shouldAttachShadowWorker('nes'), false,
    'NES uses 0-GC main-thread savestates (~2ms) instead of JSON worker cloning'
  );

  // 1. Explicit NES Shadow Worker (always runs with synthetic Mapper 0 ROM)
  const { binaryString } = createDualControllerTestRom(0);
  const nes1 = new jsnes.NES({}); nes1.loadROM(binaryString);
  nes1._romBinaryString = binaryString;
  const nes2 = new jsnes.NES({}); nes2.loadROM(binaryString);
  const nesSt = await runUniversalShadowScenario('NES', nes1, nes2, 72);
  assert.ok(
    nesSt.pooledReuses > 0,
    `Expected pooled ArrayBuffer reuses > 0, got ${nesSt.pooledReuses}`
  );
  console.log(
    `[PASS] C2b-1: NES Shadow Worker (swaps=${nesSt.shadowSwaps}, ` +
      `pooledReuses=${nesSt.pooledReuses}, 0 desyncs)`
  );

  // 2. Real SNES & Sega MD Shadow Workers when local ROMs exist
  const loadLocalRom = (dir, rx) => {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir);
    const raw = files.find((n) => rx.test(n));
    if (raw) {
      return {
        name: raw, u8: new Uint8Array(fs.readFileSync(path.join(dir, raw)))
      };
    }
    const zip = files.find((n) => /\.zip$/i.test(n));
    if (!zip) return null;
    const ext = extractRomFromZipBuffer(fs.readFileSync(path.join(dir, zip)));
    return ext?.romBuffer
      ? { name: ext.romName, u8: new Uint8Array(ext.romBuffer) } : null;
  };
  const snesRom = loadLocalRom(
    path.join(ROOT, 'local', 'snes'), /\.(sfc|smc)$/i
  );
  if (snesRom) {
    const c1 = await createSnes9xCore({
      romBytes: snesRom.u8, romName: snesRom.name
    });
    const c2 = await createSnes9xCore({
      romBytes: snesRom.u8, romName: snesRom.name
    });
    const st = await runUniversalShadowScenario('SNES', c1, c2, 50);
    console.log(
      `[PASS] C2b-2: SNES Shadow (${snesRom.name}: swaps=${st.shadowSwaps}, ` +
        `pooledReuses=${st.pooledReuses}, 0 desyncs)`
    );
  }
  const segaRom = loadLocalRom(
    path.join(ROOT, 'local', 'sega'), /\.(gen|md)$/i
  );
  if (segaRom) {
    const c1 = await createSegaGpgxCore({
      romBytes: segaRom.u8, romName: segaRom.name, systemId: 'sega_md'
    });
    const c2 = await createSegaGpgxCore({
      romBytes: segaRom.u8, romName: segaRom.name, systemId: 'sega_md'
    });
    const st = await runUniversalShadowScenario('SEGA_MD', c1, c2, 50);
    console.log(
      `[PASS] C2b-3: Sega Shadow (${segaRom.name}: swaps=${st.shadowSwaps}, ` +
        `pooledReuses=${st.pooledReuses}, 0 desyncs)`
    );
  }
}

await testC2aAudioWorkletAndDynamicRate();
testC2aLinearAudioResampling();
await testC2bUniversalShadowWorker();
console.log('\nALL TRACK C2 TESTS PASSED!');
