// Shared Low-Latency Dynamic Rate Control (DRC) Ring & AudioWorkletProcessor
const SOURCE_SAMPLE_RATE = 48000;
const RING_SIZE = 8192;
const RING_MASK = RING_SIZE - 1;
const WORKLET_PROFILE = { prebuffer: 960, target: 1152, maxQueued: 4096 };
const SCRIPT_PROFILE = { prebuffer: 2200, target: 2600, maxQueued: 6400 };

export function createDrcAudioCore(options = {}) {
  const mode = options.mode === 'script' ? 'script' : 'worklet';
  const outSampleRate =
    options.outSampleRate > 0 ? options.outSampleRate : SOURCE_SAMPLE_RATE;
  const prof = mode === 'worklet' ? WORKLET_PROFILE : SCRIPT_PROFILE;
  const baseStep = SOURCE_SAMPLE_RATE / outSampleRate;

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

  const stats = {
    underruns: 0, overflows: 0, samplesPushed: 0, samplesOut: 0,
    minStepRate: baseStep, maxStepRate: baseStep, energySum: 0, maxJump: 0
  };

  function pushSample(l, r) {
    stats.samplesPushed++;
    const queued = (writePtr - readPtr) & RING_MASK;
    if (queued >= prof.maxQueued) {
      stats.overflows++;
      readPtr = (writePtr - prof.target) & RING_MASK;
      readFrac = 0;
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

  function renderBlock(outL, outR) {
    const n = outL.length;
    const vol = muted ? 0 : volume;
    const queuedAtStart = (writePtr - readPtr) & RING_MASK;

    if (vol <= 0) {
      outL.fill(0);
      outR.fill(0);
      lastL = 0;
      lastR = 0;
      if (queuedAtStart > prof.target) {
        readPtr = (writePtr - prof.target) & RING_MASK;
        readFrac = 0;
      }
      return;
    }

    if (buffering) {
      if (queuedAtStart >= prof.prebuffer) {
        buffering = false;
        fadeIn = 64;
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

    const blockSrc = n * baseStep;
    const midQueue = queuedAtStart - blockSrc * 0.5;
    const diff = midQueue - prof.target;
    const lowWater = blockSrc + (mode === 'worklet' ? 280 : 400);
    let drc = 1.0 + (diff / prof.target) * 0.03;
    if (queuedAtStart < lowWater) {
      drc = Math.max(0.88, (queuedAtStart / lowWater) * 0.97);
    } else {
      drc = Math.max(0.97, Math.min(1.03, drc));
    }
    const stepRate = baseStep * drc;
    if (stepRate < stats.minStepRate) stats.minStepRate = stepRate;
    if (stepRate > stats.maxStepRate) stats.maxStepRate = stepRate;

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
        if (!hitUnderrun) { stats.underruns++; hitUnderrun = true; }
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
      targetMs: Math.round((prof.target / SOURCE_SAMPLE_RATE) * 1000)
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
