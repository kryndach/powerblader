// Shared Low-Latency Dynamic Rate Control (DRC) Ring & AudioWorkletProcessor
const SOURCE_SAMPLE_RATE = 48000;
const RING_SIZE = 8192;
const RING_MASK = RING_SIZE - 1;
const WORKLET_PROFILE = {
  prebuffer: 2880, target: 3072, maxTarget: 4608, maxQueued: 6912
};
const SCRIPT_PROFILE = {
  prebuffer: 2600, target: 3200, maxTarget: 4608, maxQueued: 6912
};
const EMA_TAU_SEC = 0.35;
const DRC_KP = 0.024;
const DRC_KI = 0.002;
const DRC_INT_LIMIT = 0.015;
const DRC_MIN = 0.985;
const DRC_MAX = 1.015;
const DRC_SLEW_PER_FRAME = 0.0025;
const HEADROOM_STEP = 384;
const HEADROOM_DECAY_SEC = 10;

export function createDrcAudioCore(options = {}) {
  const mode = options.mode === 'script' ? 'script' : 'worklet';
  const outSampleRate =
    options.outSampleRate > 0 ? options.outSampleRate : SOURCE_SAMPLE_RATE;
  const prof = mode === 'worklet' ? WORKLET_PROFILE : SCRIPT_PROFILE;
  const baseStep = SOURCE_SAMPLE_RATE / outSampleRate;
  const lowHeadroom = mode === 'worklet' ? 896 : 1024;

  const ringL = new Float32Array(RING_SIZE);
  const ringR = new Float32Array(RING_SIZE);
  let writePtr = 0;
  let readPtr = 0;
  let readFrac = 0;
  let buffering = true;
  let fadeIn = 0;
  let lastL = 0;
  let lastR = 0;
  let volume = 0.80;
  let muted = false;

  let effectiveTarget = prof.target;
  let avgQueued = prof.target;
  let currentDrc = 1.0;
  let integralDrc = 0;
  let hasRenderedSteady = false;
  let cleanBlocks = 0;
  let headroomCooldown = 0;

  const stats = {
    underruns: 0, overflows: 0, samplesPushed: 0, samplesOut: 0,
    minStepRate: baseStep, maxStepRate: baseStep, currentStepRate: baseStep,
    maxStepJump: 0, energySum: 0, maxJump: 0
  };

  function pushSample(l, r) {
    stats.samplesPushed++;
    const queued = (writePtr - readPtr) & RING_MASK;
    if (queued >= prof.maxQueued) {
      stats.overflows++;
      readPtr = (writePtr - effectiveTarget) & RING_MASK;
      readFrac = 0;
      avgQueued = effectiveTarget;
      integralDrc = 0;
      fadeIn = 64;
    }
    const next = (writePtr + 1) & RING_MASK;
    if (next !== readPtr) {
      ringL[writePtr] = l;
      ringR[writePtr] = r;
      writePtr = next;
    }
  }

  function pushChunk(bufL, bufR, len = bufL.length) {
    for (let i = 0; i < len; i++) pushSample(bufL[i], bufR[i]);
  }

  function updateDrcRate(qNow, blockLen) {
    if (headroomCooldown > 0) headroomCooldown--;
    if (qNow < lowHeadroom) {
      if (headroomCooldown <= 0) {
        effectiveTarget = Math.min(
          prof.maxTarget, effectiveTarget + HEADROOM_STEP
        );
        headroomCooldown = Math.max(
          1, Math.round((1.5 * outSampleRate) / Math.max(1, blockLen))
        );
      }
      cleanBlocks = 0;
    } else if (effectiveTarget > prof.target) {
      const span = HEADROOM_DECAY_SEC * outSampleRate;
      const decayNeed = Math.max(1, Math.round(span / Math.max(1, blockLen)));
      if (++cleanBlocks >= decayNeed) {
        effectiveTarget = Math.max(prof.target, effectiveTarget - 128);
        cleanBlocks = 0;
      }
    }

    const dtSec = blockLen / outSampleRate;
    const alpha = Math.min(1, dtSec / EMA_TAU_SEC);
    const midQueue = qNow - blockLen * baseStep * 0.5;
    avgQueued += (midQueue - avgQueued) * alpha;

    const normErr = (avgQueued - effectiveTarget) / effectiveTarget;
    const nextInt = integralDrc + normErr * DRC_KI * dtSec;
    integralDrc = Math.max(-DRC_INT_LIMIT, Math.min(DRC_INT_LIMIT, nextInt));
    let targetDrc = Math.max(
      DRC_MIN, Math.min(DRC_MAX, 1.0 + normErr * DRC_KP + integralDrc)
    );
    if (qNow < lowHeadroom) {
      const emg = 0.975 + 0.015 * (qNow / lowHeadroom);
      if (emg < targetDrc) targetDrc = emg;
    }

    const maxDelta = DRC_SLEW_PER_FRAME * (dtSec * 60);
    const prevDrc = currentDrc;
    const diff = targetDrc - currentDrc;
    currentDrc += Math.max(-maxDelta, Math.min(maxDelta, diff));
    if (hasRenderedSteady) {
      const jump = Math.abs(currentDrc - prevDrc);
      if (jump > stats.maxStepJump) stats.maxStepJump = jump;
    }
    hasRenderedSteady = true;

    const stepRate = baseStep * currentDrc;
    stats.currentStepRate = stepRate;
    if (stepRate < stats.minStepRate) stats.minStepRate = stepRate;
    if (stepRate > stats.maxStepRate) stats.maxStepRate = stepRate;
    return stepRate;
  }

  function renderBlock(outL, outR) {
    const n = outL.length;
    const vol = muted ? 0 : volume;
    let qNow = (writePtr - readPtr) & RING_MASK;

    if (vol <= 0) {
      outL.fill(0);
      outR.fill(0);
      lastL = 0;
      lastR = 0;
      fadeIn = 64;
      avgQueued = effectiveTarget;
      currentDrc = 1.0;
      integralDrc = 0;
      hasRenderedSteady = false;
      if (qNow > effectiveTarget) {
        readPtr = (writePtr - effectiveTarget) & RING_MASK;
        readFrac = 0;
      }
      return;
    }

    if (buffering) {
      const resumeLevel = Math.max(prof.prebuffer, effectiveTarget - 320);
      if (qNow >= resumeLevel) {
        buffering = false;
        fadeIn = 64;
        if (qNow > effectiveTarget + 800) {
          readPtr = (writePtr - effectiveTarget) & RING_MASK;
          readFrac = 0;
          qNow = (writePtr - readPtr) & RING_MASK;
        }
        avgQueued = qNow;
        currentDrc = 1.0;
        integralDrc = 0;
        hasRenderedSteady = false;
      } else {
        for (let i = 0; i < n; i++) {
          lastL *= 0.985;
          lastR *= 0.985;
          outL[i] = lastL;
          outR[i] = lastR;
        }
        return;
      }
    }

    const stepRate = updateDrcRate(qNow, n);
    let hitUnderrun = false;
    for (let i = 0; i < n; i++) {
      const q = (writePtr - readPtr) & RING_MASK;
      if (q > 1) {
        const i0 = readPtr;
        const i1 = (i0 + 1) & RING_MASK;
        const f = readFrac;
        let sL = (ringL[i0] + (ringL[i1] - ringL[i0]) * f) * vol;
        let sR = (ringR[i0] + (ringR[i1] - ringR[i0]) * f) * vol;
        if (fadeIn > 0) {
          const blend = (64 - fadeIn) / 64;
          sL = lastL * (1 - blend) + sL * blend;
          sR = lastR * (1 - blend) + sR * blend;
          fadeIn--;
        }
        const jump = Math.abs(sL - lastL);
        if (jump > stats.maxJump) stats.maxJump = jump;
        stats.energySum += sL * sL;
        stats.samplesOut++;
        lastL = sL;
        lastR = sR;
        outL[i] = sL;
        outR[i] = sR;

        readFrac += stepRate;
        const adv = readFrac | 0;
        if (adv > 0) {
          const step = adv < q ? adv : q - 1;
          readPtr = (readPtr + step) & RING_MASK;
          readFrac -= adv;
        }
      } else {
        if (!hitUnderrun) {
          stats.underruns++;
          hitUnderrun = true;
          effectiveTarget = Math.min(
            prof.maxTarget, effectiveTarget + HEADROOM_STEP
          );
          cleanBlocks = 0;
        }
        buffering = true;
        readFrac = 0;
        lastL *= 0.985;
        lastR *= 0.985;
        outL[i] = lastL;
        outR[i] = lastR;
      }
    }
  }

  function reset() {
    readPtr = writePtr;
    readFrac = 0;
    buffering = true;
    fadeIn = 64;
    effectiveTarget = prof.target;
    avgQueued = prof.target;
    currentDrc = 1.0;
    integralDrc = 0;
    hasRenderedSteady = false;
    cleanBlocks = 0;
    headroomCooldown = 0;
  }

  function setGain(nextVol, nextMuted) {
    if (typeof nextVol === 'number') volume = nextVol;
    if (typeof nextMuted === 'boolean') muted = nextMuted;
  }

  function getStats() {
    const rms = stats.samplesOut > 0
      ? Math.sqrt(stats.energySum / stats.samplesOut) : 0;
    const queued = (writePtr - readPtr) & RING_MASK;
    return {
      ...stats, rms, queued, sampleRate: outSampleRate, buffering, mode,
      targetMs: Math.round((effectiveTarget / SOURCE_SAMPLE_RATE) * 1000)
    };
  }

  return {
    pushSample, pushChunk, renderBlock, reset, setGain, getStats,
    targetMs: Math.round((prof.target / SOURCE_SAMPLE_RATE) * 1000),
    baseStep, mode
  };
}

if (typeof AudioWorkletProcessor === 'function' &&
    typeof registerProcessor === 'function') {
  class NetplayDrcProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const sr = options?.processorOptions?.sampleRate ||
        globalThis.sampleRate || SOURCE_SAMPLE_RATE;
      this.core = createDrcAudioCore({ outSampleRate: sr, mode: 'worklet' });
      this.quanta = 0;
      this.port.onmessage = (ev) => {
        const m = ev.data;
        if (!m) return;
        if (m.type === 'chunk') {
          this.core.pushChunk(m.l, m.r, m.len);
          this.port.postMessage(
            { type: 'recycle', l: m.l.buffer, r: m.r.buffer },
            [m.l.buffer, m.r.buffer]
          );
        } else if (m.type === 'gain') {
          this.core.setGain(m.volume, m.muted);
        } else if (m.type === 'reset') {
          this.core.reset();
        }
      };
    }

    process(_inputs, outputs) {
      const out = outputs[0];
      if (!out || out.length < 2) return true;
      this.core.renderBlock(out[0], out[1]);
      if (++this.quanta % 30 === 0) {
        this.port.postMessage({ type: 'stats', stats: this.core.getStats() });
      }
      return true;
    }
  }
  registerProcessor('netplay-drc-processor', NetplayDrcProcessor);
}
