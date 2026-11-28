// Adversarial Audio & Pacing Edge-Case Regressions (120Hz, VRR, Turbo, Suspend)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCoopServer } from '../server/relay_server.mjs';
import { createDrcAudioCore } from '../public/js/audio_worklet_processor.mjs';
import { createAudioDrcEngine } from '../public/js/audio_drc.mjs';
import {
  stepPacingAccumulator, FRAME_DURATION_MS
} from '../public/js/frame_loop.mjs';
import { createMinimalArcadeTestZip } from '../src/fbneo_arcade_core.mjs';
import {
  sleep, findChromiumBinary, createCdpTab, waitFor, launchHeadlessBrowser
} from './browser_cdp_harness.mjs';
import { resolveSaveSlotPath } from './tetris_scenarios.mjs';
import { buildFileUploadJs } from './test_rom_builder_tables.mjs';

function makeSine(len, startIdx, freq = 440, amp = 0.5) {
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    buf[i] = Math.sin((2 * Math.PI * freq * (startIdx + i)) / 48000) * amp;
  }
  return buf;
}

export function testEdge1Pacing120HzHitchesAndVrr() {
  const cases = [
    ['120Hz+dropVSync', [8.32, 8.32, 16.67, 8.32, 8.32, 8.32], 0.3],
    ['60Hz+24msHitch', [...Array(9).fill(FRAME_DURATION_MS), 24.0], 0.3],
    ['60Hz+23msHitch', [...Array(19).fill(FRAME_DURATION_MS), 23.0], 0.3],
    ['56Hz-VRR', [1000 / 56], 0.5],
    ['58Hz-VRR', [1000 / 58], 0.5],
    ['64Hz-VRR', [1000 / 64], 0.5],
    ['16ms-Timer-62.5Hz', [16.0], 0.5]
  ];
  for (const [name, pat, tolFps] of cases) {
    let acc = 0, ticks = 0, totalMs = 0;
    const paceState = { snapDebtMs: 0 };
    for (let i = 0; i < 1200; i++) {
      const dt = pat[i % pat.length];
      totalMs += dt;
      const r = stepPacingAccumulator(acc, dt, 0, true, paceState);
      acc = r.accumulatorMs;
      while (acc >= r.effectiveFrameMs) {
        acc -= r.effectiveFrameMs;
        ticks++;
      }
    }
    const fps = ticks / (totalMs / 1000);
    assert.ok(
      Math.abs(fps - 60) <= tolFps,
      `${name}: paced at ${fps.toFixed(2)} FPS (expected 60 +/-${tolFps})`
    );
  }
  // 60Hz symmetric DWM jitter still has 0 skips & 0 doubles with paceState
  let acc = 0, skips = 0, doubles = 0;
  const jitterState = { snapDebtMs: 0 };
  for (let i = 0; i < 200; i++) {
    const dt = (i & 1) === 0 ? 15.2 : 18.1333;
    const r = stepPacingAccumulator(acc, dt, 0, true, jitterState);
    acc = r.accumulatorMs;
    let steps = 0;
    while (acc >= r.effectiveFrameMs) { acc -= r.effectiveFrameMs; steps++; }
    if (steps === 0) skips++;
    if (steps > 1) doubles++;
  }
  assert.strictEqual(skips, 0, `60Hz DWM jitter skipped ${skips} frames`);
  assert.strictEqual(doubles, 0, `60Hz DWM jitter doubled ${doubles} frames`);
  console.log('[PASS] Edge-1: 120Hz Drop-VSync, 23-24ms Hitches & VRR Pacing');
}

export function testEdge2DrcRecoveryIntegralResetAndWaveform() {
  // A. 70ms recurring glitches at exact 60Hz must adapt in <=1 underrun
  const drc = createDrcAudioCore({ outSampleRate: 48000, mode: 'worklet' });
  const outL = new Float32Array(128), outR = new Float32Array(128);
  let sampleIdx = 0, outAcc = 0;
  const push800 = () => {
    const s = makeSine(800, sampleIdx);
    sampleIdx += 800;
    drc.pushChunk(s, s, 800);
  };
  for (let w = 0; w < 4; w++) push800();
  const glitchPat = [
    ...Array(9).fill(16.6667), 70.0, 0, 0, 0, 13.3333
  ]; // sum = 233.333ms / 14 = exact 16.6667ms
  for (let step = 0; step < 360; step++) {
    outAcc += (glitchPat[step % glitchPat.length] / 1000) * 48000;
    while (outAcc >= 128) { drc.renderBlock(outL, outR); outAcc -= 128; }
    push800();
  }
  const gst = drc.getStats();
  assert.ok(
    gst.underruns <= 1,
    `70ms glitch failed to converge after headroom expand: u=${gst.underruns}`
  );
  assert.strictEqual(gst.overflows, 0, `70ms glitch overflow=${gst.overflows}`);

  // B. Integral windup must reset on mute->unmute (no prolonged flat pitch)
  const wCore = createDrcAudioCore({ outSampleRate: 48000, mode: 'worklet' });
  for (let w = 0; w < 4; w++) {
    const s = makeSine(800, w * 800); wCore.pushChunk(s, s, 800);
  }
  let accW = 0;
  for (let f = 0; f < 300; f++) {
    accW += (17.1 / 1000) * 48000;
    while (accW >= 128) { wCore.renderBlock(outL, outR); accW -= 128; }
    const s = makeSine(800, f * 800); wCore.pushChunk(s, s, 800);
  }
  wCore.setGain(0.8, true);
  for (let f = 0; f < 5; f++) {
    const s = makeSine(800, f * 800);
    wCore.pushChunk(s, s, 800); wCore.renderBlock(outL, outR);
  }
  wCore.setGain(0.8, false);
  for (let q = 0; q < 20; q++) wCore.renderBlock(outL, outR);
  const wSt = wCore.getStats();
  assert.ok(
    wSt.currentStepRate >= 0.996,
    `Stale integral dragged pitch after unmute: sr=${wSt.currentStepRate}`
  );

  // C. Pure 440Hz waveform continuity across 48k/44.1k/96k under 40ms bursts
  for (const outRate of [48000, 44100, 96000]) {
    const c = createDrcAudioCore({ outSampleRate: outRate, mode: 'worklet' });
    const bL = new Float32Array(128), bR = new Float32Array(128);
    const pcm = [];
    let sIdx = 0, oAcc = 0;
    const p800 = () => {
      const s = makeSine(800, sIdx); sIdx += 800; c.pushChunk(s, s, 800);
    };
    for (let w = 0; w < 4; w++) p800();
    const bPat = [16.67, 10.0, 40.0, 0.0, 16.66];
    for (let step = 0; step < 240; step++) {
      oAcc += (bPat[step % bPat.length] / 1000) * outRate;
      while (oAcc >= 128) {
        c.renderBlock(bL, bR); oAcc -= 128;
        for (let i = 0; i < 128; i++) pcm.push(bL[i]);
      }
      p800();
    }
    const start = Math.floor(outRate * 0.4);
    const idealDelta = ((2 * Math.PI * 440) / outRate) * 0.5 * 0.8;
    let maxD = 0;
    for (let i = start + 1; i < pcm.length; i++) {
      const d = Math.abs(pcm[i] - pcm[i - 1]);
      if (d > maxD) maxD = d;
    }
    const st = c.getStats();
    assert.strictEqual(st.underruns, 0, `${outRate}Hz burst u=${st.underruns}`);
    assert.ok(
      maxD <= idealDelta * 1.4,
      `${outRate}Hz waveform click: maxD=${maxD.toFixed(4)} vs ${idealDelta}`
    );
  }
  console.log('[PASS] Edge-2: DRC Adaptive Prebuffer, Windup Reset & PCM');
}

export async function testEdge3SuspendedContextZeroOverflows() {
  const prevAC = globalThis.AudioContext;
  const prevAWN = globalThis.AudioWorkletNode;
  let ctxState = 'suspended';
  const workCore = createDrcAudioCore({
    outSampleRate: 48000, mode: 'worklet'
  });
  try {
    globalThis.AudioWorkletNode = class MockAWN {
      constructor() {
        this.port = {
          onmessage: null,
          postMessage: (m) => {
            if (m?.type === 'chunk') workCore.pushChunk(m.l, m.r, m.len);
            else if (m?.type === 'reset') workCore.reset();
          }
        };
      }
      connect() {}
    };
    globalThis.AudioContext = class MockAC {
      constructor() {
        this.sampleRate = 48000;
        this.destination = {};
        this.audioWorklet = { addModule: async () => {} };
      }
      get state() { return ctxState; }
      resume() { return Promise.resolve(); }
    };
    const eng = createAudioDrcEngine({});
    eng.initAudio();
    await sleep(15);
    for (let f = 0; f < 120; f++) {
      eng.beginFrame();
      for (let i = 0; i < 800; i++) eng.pushSample(0.2, -0.2);
      eng.endFrame();
    }
    assert.strictEqual(
      workCore.getStats().overflows, 0,
      `Suspended AudioContext caused ${workCore.getStats().overflows} overflows`
    );
    ctxState = 'running';
    for (let f = 0; f < 6; f++) {
      eng.beginFrame();
      for (let i = 0; i < 800; i++) eng.pushSample(0.2, -0.2);
      eng.endFrame();
    }
    const oL = new Float32Array(128), oR = new Float32Array(128);
    workCore.renderBlock(oL, oR);
    assert.ok(workCore.getStats().samplesOut > 0, 'Audio did not resume');
  } finally {
    globalThis.AudioContext = prevAC;
    globalThis.AudioWorkletNode = prevAWN;
  }
  console.log('[PASS] Edge-3: Suspended AudioContext Zero Fake Overflows');
}

export async function testEdge4ChromeTurboF8AndOfflineToOnline(rootDir) {
  const bin = findChromiumBinary();
  if (!bin) return console.log('[SKIP] Edge-4: No Chromium binary found.');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_audio_edge_'));
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
      path.join(rootDir, 'local', 'arcade', 'tgm2p.zip')
    );
    await waitFor(() => tab.evaluate(
      hasLocalTgm
        ? `document.getElementById('localRomSelect')?.options.length > 1`
        : `typeof window.__nesAudioStats === 'function'`
    ), 10000, 'edge UI ready');

    // Click BEFORE loading ROM (real user order!)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await tab.send('Input.dispatchMouseEvent', {
        type, x: 200, y: 200, button: 'left', clickCount: 1
      });
    }
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
    ), 25000, `Edge loaded ${needle}`);

    const savePath = isRealTgm
      ? resolveSaveSlotPath(rootDir, '2AAB0722', 1) : null;
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
    }
    await waitFor(() => tab.evaluate(`(() => {
      const s = window.__nesAudioStats?.();
      return s && s.mode === 'worklet' && s.samplesOut > 24000 ? s : null;
    })()`), 10000, 'Worklet active');

    // 1. Offline must NOT spawn Shadow Worker
    const offShadow = await tab.evaluate(`window.__shadowStats()`);
    assert.strictEqual(offShadow, null, 'Offline mode must not spawn shadow');

    // 2. Frequent 23ms hitches (every 250ms) -> 0 underruns on 120Hz/60Hz!
    const b0 = await tab.evaluate(`window.__nesAudioStats()`);
    await tab.evaluate(`window.__gc23 = setInterval(() => {
      const e = performance.now() + 23; while (performance.now() < e) {}
    }, 250);`);
    await sleep(3200);
    await tab.evaluate(`clearInterval(window.__gc23);`);
    const sHitch = await tab.evaluate(`window.__nesAudioStats()`);
    assert.strictEqual(
      sHitch.underruns - b0.underruns, 0,
      `23ms hitches caused ${sHitch.underruns - b0.underruns} underruns!`
    );
    assert.strictEqual(sHitch.overflows - b0.overflows, 0, '23ms overflow!');

    const b1 = await tab.evaluate(`window.__nesAudioStats()`);
    await tab.evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' }))`
    );
    await sleep(1300);
    await tab.evaluate(
      `window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab' }))`
    );
    await sleep(700);
    const sT = await tab.evaluate(`window.__nesAudioStats()`);
    assert.strictEqual(sT.underruns - b1.underruns, 0, '4x turbo underrun!');
    assert.strictEqual(sT.overflows - b1.overflows, 0, '4x turbo overflow!');

    const b2 = await tab.evaluate(`window.__nesAudioStats()`);
    await tab.evaluate(`document.getElementById('quickSaveBtn').click()`);
    await sleep(300);
    await tab.evaluate(`document.getElementById('quickLoadBtn').click()`);
    await sleep(700);
    const sL = await tab.evaluate(`window.__nesAudioStats()`);
    assert.strictEqual(sL.underruns - b2.underruns, 0, 'F6/F8 load underrun!');
    assert.strictEqual(sL.overflows - b2.overflows, 0, 'F6/F8 load overflow!');

    await tab.evaluate(`(() => {
      document.getElementById('roomInput').value = 'LAZYSH';
      document.getElementById('connectBtn').click();
    })()`);
    await waitFor(
      () => tab.evaluate(`window.__shadowStats()?.ready === true`),
      12000, 'Lazy shadow attach on Connect'
    );
    assert.strictEqual(tab.exceptions.length, 0, tab.exceptions.join('; '));
    console.log(
      `[PASS] Edge-4: Chrome ${needle} (23ms Hitch, 4x Turbo, F6/F8 & Shadow)`
    );
    tab.close();
  } finally {
    if (browser?.proc) { try { browser.proc.kill('SIGKILL'); } catch {} }
    await sleep(120); await app.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
