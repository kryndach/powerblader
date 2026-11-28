// Real-Time AudioWorklet (Zero-COOP) + ScriptProcessor Fallback Audio DRC
import { createDrcAudioCore } from './audio_worklet_processor.mjs';

const WORKLET_AUTO_FLUSH_LEN = 256;
const WORKLET_BUF_CAP = 1024;
const SCRIPT_BLOCK_SIZE = 1024;
const MAX_POOL_PAIRS = 8;

export function createAudioDrcEngine(
  { muteBtn, volumeSlider, volumeValLabel } = {}
) {
  let audioCtx = null;
  let workletNode = null;
  let scriptNode = null;
  let scriptCore = null;
  let mode = 'idle';
  let workletBooting = false;
  let ctxSuspended = false;
  let audioMuted = false;
  let audioVolume = 0.80;
  let totalPushed = 0;
  let workletStats = null;
  let inFrame = false;

  const chunkPool = [];
  let stageL = new Float32Array(WORKLET_BUF_CAP);
  let stageR = new Float32Array(WORKLET_BUF_CAP);
  let stagePos = 0;
  const bootQueue = [];

  try {
    const savedVol = localStorage.getItem('nes_volume');
    if (savedVol !== null) {
      const v = Number(savedVol);
      if (Number.isFinite(v) && v >= 0 && v <= 100) {
        audioVolume = v / 100;
        if (volumeSlider) volumeSlider.value = String(Math.round(v));
        if (volumeValLabel) volumeValLabel.textContent = `${Math.round(v)}%`;
      }
    }
  } catch {}

  function takeChunkPair() {
    while (chunkPool.length > 0) {
      const recycled = chunkPool.pop();
      if (recycled && recycled[0].length >= WORKLET_BUF_CAP) return recycled;
    }
    return [
      new Float32Array(WORKLET_BUF_CAP), new Float32Array(WORKLET_BUF_CAP)
    ];
  }

  function syncGainToActiveEngine() {
    if (workletNode) {
      try {
        workletNode.port.postMessage({
          type: 'gain', volume: audioVolume, muted: audioMuted
        });
      } catch {}
    }
    if (scriptCore) scriptCore.setGain(audioVolume, audioMuted);
  }

  function attachScriptFallback() {
    if (!audioCtx || scriptNode || workletNode) return;
    const sr = audioCtx.sampleRate || 48000;
    scriptCore = createDrcAudioCore({ outSampleRate: sr, mode: 'script' });
    scriptCore.setGain(audioVolume, audioMuted);
    while (bootQueue.length > 0) {
      const [bl, br, len] = bootQueue.shift();
      scriptCore.pushChunk(bl, br, len);
    }
    if (stagePos > 0) {
      scriptCore.pushChunk(stageL, stageR, stagePos);
      stagePos = 0;
    }
    if (typeof audioCtx.createScriptProcessor === 'function') {
      scriptNode = audioCtx.createScriptProcessor(SCRIPT_BLOCK_SIZE, 0, 2);
      scriptNode.onaudioprocess = (e) => {
        scriptCore.renderBlock(
          e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1)
        );
      };
      scriptNode.connect(audioCtx.destination);
    }
    mode = 'script';
  }

  function syncCtxSuspended() {
    ctxSuspended = Boolean(audioCtx && audioCtx.state === 'suspended');
    return ctxSuspended;
  }

  function flushStageToWorklet(len = stagePos) {
    if (len <= 0 || syncCtxSuspended()) { stagePos = 0; return; }
    const sendL = stageL;
    const sendR = stageR;
    [stageL, stageR] = takeChunkPair();
    stagePos = 0;
    if (workletNode) {
      try {
        workletNode.port.postMessage(
          { type: 'chunk', l: sendL, r: sendR, len },
          [sendL.buffer, sendR.buffer]
        );
      } catch {}
    } else if (bootQueue.length < 24) {
      bootQueue.push([sendL, sendR, len]);
    }
  }

  function resumeIfSuspended() {
    if (!audioCtx || audioCtx.state !== 'suspended' ||
        typeof audioCtx.resume !== 'function') {
      syncCtxSuspended();
      return Promise.resolve();
    }
    syncCtxSuspended();
    return Promise.resolve(audioCtx.resume())
      .then(() => { syncCtxSuspended(); })
      .catch(() => { syncCtxSuspended(); });
  }

  function initAudio() {
    if (audioCtx) return resumeIfSuspended();
    const win = typeof window !== 'undefined' ? window : globalThis;
    const AudioContextClass = win.AudioContext || win.webkitAudioContext;
    if (!AudioContextClass) return Promise.resolve();
    try {
      audioCtx = new AudioContextClass({
        sampleRate: 48000, latencyHint: 'interactive'
      });
    } catch {
      audioCtx = new AudioContextClass();
    }
    if (typeof audioCtx.addEventListener === 'function') {
      audioCtx.addEventListener('statechange', syncCtxSuspended);
    }
    const resumeP = resumeIfSuspended();
    const hasWorklet = Boolean(
      audioCtx.audioWorklet?.addModule &&
      typeof win.AudioWorkletNode === 'function'
    );
    if (!hasWorklet) {
      attachScriptFallback();
      return resumeP;
    }
    workletBooting = true;
    const modUrl = new URL('./audio_worklet_processor.mjs', import.meta.url);
    audioCtx.audioWorklet.addModule(modUrl.href).then(() => {
      workletBooting = false;
      if (!audioCtx || scriptNode) return;
      const node = new win.AudioWorkletNode(audioCtx, 'netplay-drc-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { sampleRate: audioCtx.sampleRate || 48000 }
      });
      node.port.onmessage = (ev) => {
        const m = ev.data;
        if (!m) return;
        if (m.type === 'stats') workletStats = m.stats;
        else if (m.type === 'recycle' && chunkPool.length < MAX_POOL_PAIRS) {
          chunkPool.push([new Float32Array(m.l), new Float32Array(m.r)]);
        }
      };
      node.connect(audioCtx.destination);
      workletNode = node;
      scriptCore = null;
      mode = 'worklet';
      syncGainToActiveEngine();
      if (syncCtxSuspended()) {
        bootQueue.length = 0;
        stagePos = 0;
      } else {
        while (bootQueue.length > 0) {
          const [bl, br, len] = bootQueue.shift();
          node.port.postMessage(
            { type: 'chunk', l: bl, r: br, len }, [bl.buffer, br.buffer]
          );
        }
        if (stagePos > 0) flushStageToWorklet(stagePos);
      }
    }).catch(() => {
      workletBooting = false;
      attachScriptFallback();
    });
    return resumeP;
  }

  function beginFrame() {
    syncCtxSuspended();
    inFrame = true;
  }

  function endFrame() {
    inFrame = false;
    if ((mode === 'worklet' || workletBooting) && stagePos > 0) {
      flushStageToWorklet(stagePos);
    }
  }

  function pushSample(l, r) {
    if (ctxSuspended) { stagePos = 0; return; }
    totalPushed++;
    if (mode === 'script' && scriptCore) {
      scriptCore.pushSample(l, r);
      return;
    }
    if (mode === 'worklet' || workletBooting) {
      stageL[stagePos] = l;
      stageR[stagePos] = r;
      const limit = inFrame ? WORKLET_BUF_CAP : WORKLET_AUTO_FLUSH_LEN;
      if (++stagePos >= limit) flushStageToWorklet(stagePos);
      return;
    }
    if (!scriptCore) {
      scriptCore = createDrcAudioCore({ outSampleRate: 48000, mode: 'script' });
      scriptCore.setGain(audioVolume, audioMuted);
    }
    scriptCore.pushSample(l, r);
  }

  function resetBuffer() {
    stagePos = 0;
    bootQueue.length = 0;
    if (workletNode) {
      try { workletNode.port.postMessage({ type: 'reset' }); } catch {}
    }
    if (scriptCore) scriptCore.reset();
  }

  function getStats() {
    if (mode === 'worklet' && workletStats) {
      return { ...workletStats, samplesPushed: totalPushed, mode: 'worklet' };
    }
    if (mode !== 'worklet' && !workletBooting && scriptCore) {
      return {
        ...scriptCore.getStats(),
        samplesPushed: totalPushed,
        sampleRate: audioCtx ? audioCtx.sampleRate : 0,
        mode: 'script'
      };
    }
    const isWl = mode === 'worklet' || workletBooting;
    return {
      underruns: 0, overflows: 0, samplesPushed: totalPushed, samplesOut: 0,
      minStepRate: 1, maxStepRate: 1, maxStepJump: 0, energySum: 0,
      maxJump: 0, rms: 0, queued: stagePos,
      sampleRate: audioCtx ? audioCtx.sampleRate : 0,
      buffering: true, mode, targetMs: isWl ? 64 : 67
    };
  }

  function updateAudioControlsUI() {
    const pct = Math.round(audioVolume * 100);
    const isMuted = audioMuted || pct === 0;
    if (muteBtn) muteBtn.textContent = isMuted ? '\u{1F507}' : '\u{1F50A}';
    if (volumeValLabel) {
      volumeValLabel.textContent = audioMuted ? 'MUTE' : `${pct}%`;
    }
  }
  updateAudioControlsUI();

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      initAudio();
      audioMuted = !audioMuted;
      if (!audioMuted && audioVolume <= 0) {
        audioVolume = 0.80;
        if (volumeSlider) volumeSlider.value = '80';
      }
      syncGainToActiveEngine();
      updateAudioControlsUI();
    });
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      initAudio();
      const val = Math.max(0, Math.min(100, Number(volumeSlider.value) || 0));
      audioVolume = val / 100;
      audioMuted = val === 0;
      try { localStorage.setItem('nes_volume', String(val)); } catch {}
      syncGainToActiveEngine();
      updateAudioControlsUI();
    });
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    const detachGestures = () => {
      window.removeEventListener?.('keydown', onUserGesture);
      window.removeEventListener?.('pointerdown', onUserGesture);
    };
    function onUserGesture() {
      const p = initAudio();
      if (!audioCtx) return;
      if (audioCtx.state === 'running') return detachGestures();
      Promise.resolve(p).then(() => {
        if (audioCtx?.state === 'running') detachGestures();
      }).catch(() => {});
    }
    window.addEventListener('keydown', onUserGesture);
    window.addEventListener('pointerdown', onUserGesture);
  }

  return { initAudio, pushSample, beginFrame, endFrame, resetBuffer, getStats };
}
