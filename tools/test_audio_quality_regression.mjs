// Real-World Audio Quality Regression Suite (Offline Arcade & Worklet DRC)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCoopServer } from '../server/relay_server.mjs';
import { createDrcAudioCore } from '../public/js/audio_worklet_processor.mjs';
import { createAudioDrcEngine } from '../public/js/audio_drc.mjs';
import { stepPacingAccumulator } from '../public/js/frame_loop.mjs';
import { createMinimalArcadeTestZip } from '../src/fbneo_arcade_core.mjs';
import {
  sleep, findChromiumBinary, createCdpTab, waitFor, launchHeadlessBrowser
} from './browser_cdp_harness.mjs';
import { resolveSaveSlotPath } from './tetris_scenarios.mjs';
import { buildFileUploadJs } from './test_rom_builder_tables.mjs';
import {
  testEdge1Pacing120HzHitchesAndVrr,
  testEdge2DrcRecoveryIntegralResetAndWaveform,
  testEdge3SuspendedContextZeroOverflows,
  testEdge4ChromeTurboF8AndOfflineToOnline
} from './audio_regression_edge_cases.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function makeSine(len, startIdx, freq = 440, amp = 0.5) {
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    buf[i] = Math.sin((2 * Math.PI * freq * (startIdx + i)) / 48000) * amp;
  }
  return buf;
}

function test1WorkletZeroFmWarbleUnderWasapiBursts() {
  for (const outRate of [48000, 44100]) {
    const drc = createDrcAudioCore({ outSampleRate: outRate, mode: 'worklet' });
    const base = 48000 / outRate;
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    const simMs = 4000;
    const framePeriod = 1000 / 60;
    const wasapiPeriod = 10; // Windows WASAPI 10ms hardware callback bursts
    let nextFrame = 0, nextWasapi = 10, sampleIdx = 0, outClock = 0;
    const steadyDrcs = [];

    for (let t = 0; t <= simMs; t += 0.5) {
      if (t >= nextFrame) {
        const s = makeSine(800, sampleIdx);
        sampleIdx += 800;
        drc.pushChunk(s, s, 800);
        nextFrame += framePeriod;
      }
      if (t >= nextWasapi) {
        outClock += (wasapiPeriod / 1000) * outRate;
        while (outClock >= 128) {
          const prevOut = drc.getStats().samplesOut;
          drc.renderBlock(outL, outR);
          outClock -= 128;
          const st = drc.getStats();
          if (t >= 600 && st.samplesOut > prevOut) {
            const cur = st.currentStepRate ?? st.maxStepRate;
            steadyDrcs.push(cur / base);
          }
        }
        nextWasapi += wasapiPeriod;
      }
    }

    const st = drc.getStats();
    assert.strictEqual(st.underruns, 0, `${outRate}Hz WASAPI underruns`);
    assert.strictEqual(st.overflows, 0, `${outRate}Hz WASAPI overflows`);
    assert.ok(st.rms > 0.25, `${outRate}Hz RMS too low: ${st.rms}`);

    const minRatio = st.minStepRate / base;
    const maxRatio = st.maxStepRate / base;
    const swingPct = (maxRatio - minRatio) * 100;
    assert.ok(
      swingPct <= 2.5,
      `${outRate}Hz 60Hz pitch FM warble too high: ${swingPct.toFixed(2)}% ` +
        `[${minRatio.toFixed(4)}..${maxRatio.toFixed(4)}]`
    );
    let maxJumpPct = 0;
    for (let i = 1; i < steadyDrcs.length; i++) {
      const jp = Math.abs(steadyDrcs[i] - steadyDrcs[i - 1]) * 100;
      if (jp > maxJumpPct) maxJumpPct = jp;
    }
    const statJumpPct = (st.maxStepJump ?? (maxJumpPct / 100)) * 100;
    assert.ok(
      Math.max(maxJumpPct, statJumpPct) <= 0.35,
      `${outRate}Hz per-quantum pitch jump too large: ` +
        `trace=${maxJumpPct.toFixed(3)}% stat=${statJumpPct.toFixed(3)}%`
    );
  }
  console.log('[PASS] Audio-1: Zero 60Hz FM Pitch Warble under 10ms WASAPI');
}

function test2WorkletSurvives40msBurstAnd28msGcHitches() {
  const scenarios = [
    { name: '40ms-WASAPI-Burst', pattern: [16.67, 10.0, 40.0, 0.0, 16.67] },
    { name: '28ms-GC-Hitches', pattern: [16.67, 16.67, 16.67, 28.0, 5.34] },
    { name: '144Hz-Refresh', pattern: [20.83, 13.89, 20.83, 13.89, 13.89] },
    { name: '75Hz-Refresh', pattern: [26.67, 13.33, 13.33, 13.33] },
    { name: '59.4Hz-SlowClock', pattern: [1000 / 59.4] },
    { name: '60.5Hz-FastClock', pattern: [1000 / 60.5] }
  ];
  for (const sc of scenarios) {
    const drc = createDrcAudioCore({ outSampleRate: 48000, mode: 'worklet' });
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    let sampleIdx = 0, outAcc = 0;

    // Warm 4 frames before jitter begins
    for (let w = 0; w < 4; w++) {
      const s = makeSine(800, sampleIdx);
      sampleIdx += 800;
      drc.pushChunk(s, s, 800);
    }
    for (let step = 0; step < 240; step++) {
      const gapMs = sc.pattern[step % sc.pattern.length];
      outAcc += (gapMs / 1000) * 48000;
      while (outAcc >= 128) {
        drc.renderBlock(outL, outR);
        outAcc -= 128;
      }
      const s = makeSine(800, sampleIdx);
      sampleIdx += 800;
      drc.pushChunk(s, s, 800);
    }
    const st = drc.getStats();
    assert.strictEqual(st.underruns, 0, `${sc.name}: u=${st.underruns}`);
    assert.strictEqual(st.overflows, 0, `${sc.name}: ovf=${st.overflows}`);
    assert.ok(
      st.minStepRate >= 0.96 && st.maxStepRate <= 1.03,
      `${sc.name}: severe pitch cliff [${st.minStepRate.toFixed(4)}..` +
        `${st.maxStepRate.toFixed(4)}]`
    );
  }
  console.log('[PASS] Audio-2: 0 Underruns on 40ms Burst, 28ms GC, 144/75Hz');
}

async function test3FrameAlignedFlushAndPacingCarry() {
  // A. Verify frame-aligned flush sends 1 clean 800-sample chunk per frame
  const posted = [];
  const prevAC = globalThis.AudioContext;
  const prevAWN = globalThis.AudioWorkletNode;
  try {
    globalThis.AudioWorkletNode = class MockAWN {
      constructor() {
        this.port = {
          postMessage(m) { posted.push(m); },
          onmessage: null
        };
      }
      connect() {}
    };
    globalThis.AudioContext = class MockAC {
      constructor() {
        this.sampleRate = 48000;
        this.state = 'running';
        this.destination = {};
        this.audioWorklet = { addModule: async () => {} };
      }
      resume() { return Promise.resolve(); }
    };
    const eng = createAudioDrcEngine({});
    eng.initAudio();
    await sleep(15);
    posted.length = 0;

    assert.strictEqual(typeof eng.beginFrame, 'function', 'beginFrame missing');
    assert.strictEqual(typeof eng.endFrame, 'function', 'endFrame missing');
    eng.beginFrame();
    for (let i = 0; i < 800; i++) eng.pushSample(0.2, -0.2);
    eng.endFrame();
    const chunks = posted.filter((m) => m?.type === 'chunk');
    assert.strictEqual(
      chunks.length, 1, `Expected 1 frame chunk, got ${chunks.length}`
    );
    assert.strictEqual(chunks[0].len, 800, `Bad len=${chunks[0].len}`);
  } finally {
    globalThis.AudioContext = prevAC;
    globalThis.AudioWorkletNode = prevAWN;
  }

  // B. Verify mute -> unmute fades in click-free without pitch transient
  const mCore = createDrcAudioCore({ outSampleRate: 48000, mode: 'worklet' });
  const oL = new Float32Array(128), oR = new Float32Array(128);
  const dc = new Float32Array(3000).fill(0.5);
  mCore.pushChunk(dc, dc, 3000);
  mCore.setGain(0.8, true);
  mCore.renderBlock(oL, oR);
  assert.strictEqual(oL[64], 0, 'Muted output must be silent');
  mCore.setGain(0.8, false);
  mCore.renderBlock(oL, oR);
  assert.ok(
    Math.abs(oL[0]) < Math.abs(oL[63]) && Math.abs(oL[63]) > 0.3,
    'Unmute must fade in smoothly'
  );

  let acc = 0, totalTicks = 0;
  const pattern = [18.5, 14.7, 16.8];
  for (let i = 0; i < 300; i++) {
    const r = stepPacingAccumulator(acc, pattern[i % 3], 0, true);
    acc = r.accumulatorMs;
    while (acc >= r.effectiveFrameMs) {
      acc -= r.effectiveFrameMs; totalTicks++;
    }
  }
  assert.ok(totalTicks >= 298 && totalTicks <= 302, `Dropped: ${totalTicks}`);
  console.log('[PASS] Audio-3: Frame Flush, Mute Fade-In & 60Hz VSync Carry');
}

async function test4RealChromeOfflineArcadeAudioQuality() {
  const bin = findChromiumBinary();
  if (!bin) return console.log('[SKIP] Audio-4: No Chromium binary found.');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_audio_reg_'));
  const app = createCoopServer({
    logAccess: false, logsDir: path.join(tmpDir, 'logs'),
    savesDir: path.join(tmpDir, 'saves')
  });
  const port = await app.listen(0, '127.0.0.1');
  let browser = null;
  try {
    browser = await launchHeadlessBrowser(bin, path.join(tmpDir, 'profile'));
    const tab = await createCdpTab(
      browser.debugPort, `http://127.0.0.1:${port}/?debug=1`
    );
    const hasLocalTgm = !process.env.FORCE_SYNTHETIC_ROM && fs.existsSync(
      path.join(ROOT_DIR, 'local', 'arcade', 'tgm2p.zip')
    );
    await waitFor(() => tab.evaluate(
      hasLocalTgm
        ? `document.getElementById('localRomSelect')?.options.length > 1`
        : `typeof window.__nesAudioStats === 'function'`
    ), 10000, 'offline UI ready');

    const picked = hasLocalTgm ? await tab.evaluate(`(() => {
      const sel = document.getElementById('localRomSelect');
      const pick = [...sel.options].map((o) => o.value)
        .find((v) => v.toLowerCase().includes('tgm2p'));
      if (!pick) return '';
      sel.value = pick;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return pick;
    })()`) : '';
    const isRealTgm = Boolean(picked);
    if (!isRealTgm) {
      await tab.evaluate(
        buildFileUploadJs(createMinimalArcadeTestZip(), 'minivadr.zip')
      );
    }
    const needle = isRealTgm ? 'tgm2p' : 'minivadr';
    await waitFor(() => tab.evaluate(
      `document.getElementById('romBadge')?.textContent.toLowerCase()` +
        `.includes('${needle}')`
    ), 25000, `Offline loaded ${needle}`);

    const savePath = isRealTgm
      ? resolveSaveSlotPath(ROOT_DIR, '2AAB0722', 1) : null;
    if (savePath) {
      const raw = fs.readFileSync(savePath, 'utf8');
      await tab.evaluate(`(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify(raw)}], 'slot1.sav.json', {
          type: 'application/json'
        }));
        const inp = document.getElementById('saveFileInput');
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(300);
    }

    // Real user gesture via CDP to start & unlock AudioWorklet
    for (const type of ['mousePressed', 'mouseReleased']) {
      await tab.send('Input.dispatchMouseEvent', {
        type, x: 200, y: 200, button: 'left', clickCount: 1
      });
    }
    await waitFor(() => tab.evaluate(`(() => {
      const s = window.__nesAudioStats?.();
      return s && s.mode === 'worklet' && s.samplesOut > 24000 ? s : null;
    })()`), 10000, 'AudioWorklet actively rendering');

    await sleep(900);
    const base = await tab.evaluate(`window.__nesAudioStats()`);

    // Simulate realistic offline gameplay: keypresses + routine 28ms hitches
    await tab.evaluate(`(() => {
      const keys = ['ArrowLeft', 'KeyZ', 'ArrowRight', 'KeyX', 'ArrowDown'];
      let i = 0;
      window.__ak = setInterval(() => {
        const k = keys[i++ % keys.length];
        window.dispatchEvent(new KeyboardEvent('keydown', { code: k }));
        setTimeout(() => window.dispatchEvent(
          new KeyboardEvent('keyup', { code: k })
        ), 60);
      }, 160);
      window.__ah = setInterval(() => {
        const end = performance.now() + 28;
        while (performance.now() < end) {}
      }, 1800);
    })()`);
    await sleep(5800);
    await tab.evaluate(
      `clearInterval(window.__ak); clearInterval(window.__ah)`
    );
    const cur = await tab.evaluate(`window.__nesAudioStats()`);
    const dU = cur.underruns - base.underruns;
    const dO = cur.overflows - base.overflows;
    const dOut = cur.samplesOut - base.samplesOut;
    const srBase = 48000 / (cur.sampleRate || 48000);
    const minR = cur.minStepRate / srBase, maxR = cur.maxStepRate / srBase;
    const swingPct = (maxR - minR) * 100;
    const jumpPct = (cur.maxStepJump || 0) * 100;
    assert.strictEqual(cur.mode, 'worklet', 'Expected AudioWorklet mode');
    assert.ok(dOut >= 180000, `Audio stalled: only ${dOut} samples out`);
    if (isRealTgm) assert.ok(cur.rms > 0.015, `TGM2+ silent: rms=${cur.rms}`);
    assert.strictEqual(dU, 0, `Offline Arcade had ${dU} underruns!`);
    assert.strictEqual(dO, 0, `Offline Arcade had ${dO} overflows!`);
    assert.ok(minR >= 0.96 && maxR <= 1.03, `Pitch: [${minR}..${maxR}]`);
    assert.ok(swingPct <= 3.5, `Pitch swing ${swingPct.toFixed(2)}% > 3.5%`);
    assert.ok(jumpPct <= 0.5, `Pitch jump ${jumpPct.toFixed(3)}% > 0.5%`);
    assert.strictEqual(tab.exceptions.length, 0, tab.exceptions.join('; '));
    console.log(
      `[PASS] Audio-4: Chrome ${needle} (Worklet, 0U/0O, ` +
        `Pitch=[${minR.toFixed(4)}..${maxR.toFixed(4)}], ` +
        `Jump=${jumpPct.toFixed(3)}%, RMS=${cur.rms.toFixed(3)})`
    );
    tab.close();
  } finally {
    if (browser?.proc) { try { browser.proc.kill('SIGKILL'); } catch {} }
    await sleep(120); await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

console.log('=== Audio Quality & Pitch Stability Regression Suite ===\n');
test1WorkletZeroFmWarbleUnderWasapiBursts();
test2WorkletSurvives40msBurstAnd28msGcHitches();
await test3FrameAlignedFlushAndPacingCarry();
await test4RealChromeOfflineArcadeAudioQuality();
testEdge1Pacing120HzHitchesAndVrr();
testEdge2DrcRecoveryIntegralResetAndWaveform();
await testEdge3SuspendedContextZeroOverflows();
await testEdge4ChromeTurboF8AndOfflineToOnline(ROOT_DIR);
console.log('\nALL AUDIO QUALITY REGRESSION TESTS PASSED!');
