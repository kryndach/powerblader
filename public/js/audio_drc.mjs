// Dynamic Rate Control (DRC) Fractional Audio Resampler & Volume Controller
const AUDIO_BUFFER_MASK = 8191;
const AUDIO_PREBUFFER_SAMPLES = 1800;
const AUDIO_TARGET_SAMPLES = 2200;
const AUDIO_MAX_QUEUED_SAMPLES = 5200;

export function createAudioDrcEngine(
  { muteBtn, volumeSlider, volumeValLabel }
) {
  let audioCtx = null;
  let audioScriptNode = null;
  let audioMuted = false;
  let audioVolume = 0.80;

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

  const audioRingL = new Float32Array(8192);
  const audioRingR = new Float32Array(8192);
  let audioWritePtr = 0;
  let audioReadPtr = 0;
  let audioReadFrac = 0;
  let audioBuffering = true;
  let audioFadeInSamples = 0;
  let lastAudioSampleL = 0;
  let lastAudioSampleR = 0;

  function initAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return;
    }
    const win = typeof window !== 'undefined' ? window : globalThis;
    const AudioContextClass = win.AudioContext || win.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      audioCtx = new AudioContextClass({ sampleRate: 48000 });
    } catch {
      audioCtx = new AudioContextClass();
    }
    audioScriptNode = audioCtx.createScriptProcessor(1024, 0, 2);
    audioScriptNode.onaudioprocess = (e) => {
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      const vol = audioMuted ? 0 : audioVolume;
      const queuedAtStart = (audioWritePtr - audioReadPtr) & AUDIO_BUFFER_MASK;

      if (vol <= 0) {
        for (let i = 0; i < outL.length; i++) {
          outL[i] = 0;
          outR[i] = 0;
        }
        lastAudioSampleL = 0;
        lastAudioSampleR = 0;
        if (queuedAtStart > AUDIO_TARGET_SAMPLES) {
          audioReadPtr =
            (audioWritePtr - AUDIO_TARGET_SAMPLES) & AUDIO_BUFFER_MASK;
          audioReadFrac = 0;
        }
        return;
      }

      if (audioBuffering) {
        if (queuedAtStart >= AUDIO_PREBUFFER_SAMPLES) {
          audioBuffering = false;
          audioFadeInSamples = 64;
        } else {
          for (let i = 0; i < outL.length; i++) {
            lastAudioSampleL *= 0.985;
            lastAudioSampleR *= 0.985;
            outL[i] = lastAudioSampleL;
            outR[i] = lastAudioSampleR;
          }
          return;
        }
      }

      const diff = queuedAtStart - AUDIO_TARGET_SAMPLES;
      let stepRate = 1.0 + (diff / AUDIO_TARGET_SAMPLES) * 0.045;
      if (queuedAtStart < 1200) {
        stepRate = Math.max(0.82, (queuedAtStart / 1200) * 0.96);
      } else {
        stepRate = Math.max(0.95, Math.min(1.05, stepRate));
      }

      for (let i = 0; i < outL.length; i++) {
        const q = (audioWritePtr - audioReadPtr) & AUDIO_BUFFER_MASK;
        if (q > 1) {
          const idx0 = audioReadPtr;
          const idx1 = (idx0 + 1) & AUDIO_BUFFER_MASK;
          const frac = audioReadFrac;
          let sL =
            (audioRingL[idx0] + (audioRingL[idx1] - audioRingL[idx0]) * frac) *
            vol;
          let sR =
            (audioRingR[idx0] + (audioRingR[idx1] - audioRingR[idx0]) * frac) *
            vol;
          if (audioFadeInSamples > 0) {
            const fade = (64 - audioFadeInSamples) / 64;
            sL = lastAudioSampleL * (1 - fade) + sL * fade;
            sR = lastAudioSampleR * (1 - fade) + sR * fade;
            audioFadeInSamples--;
          }
          lastAudioSampleL = sL;
          lastAudioSampleR = sR;
          outL[i] = sL;
          outR[i] = sR;

          audioReadFrac += stepRate;
          const adv = audioReadFrac | 0;
          if (adv > 0) {
            const step = adv < q ? adv : q - 1;
            audioReadPtr = (audioReadPtr + step) & AUDIO_BUFFER_MASK;
            audioReadFrac -= adv;
          }
        } else {
          audioBuffering = true;
          audioReadFrac = 0;
          lastAudioSampleL *= 0.985;
          lastAudioSampleR *= 0.985;
          outL[i] = lastAudioSampleL;
          outR[i] = lastAudioSampleR;
        }
      }
    };
    audioScriptNode.connect(audioCtx.destination);
  }

  function pushSample(l, r) {
    const queued = (audioWritePtr - audioReadPtr) & AUDIO_BUFFER_MASK;
    if (queued >= AUDIO_MAX_QUEUED_SAMPLES) {
      audioReadPtr =
        (audioWritePtr - AUDIO_TARGET_SAMPLES) & AUDIO_BUFFER_MASK;
      audioReadFrac = 0;
      audioFadeInSamples = 64;
    }
    const next = (audioWritePtr + 1) & AUDIO_BUFFER_MASK;
    if (next !== audioReadPtr) {
      audioRingL[audioWritePtr] = l;
      audioRingR[audioWritePtr] = r;
      audioWritePtr = next;
    }
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
      updateAudioControlsUI();
    });
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      initAudio();
      const val = Math.max(0, Math.min(100, Number(volumeSlider.value) || 0));
      audioVolume = val / 100;
      audioMuted = val === 0;
      try {
        localStorage.setItem('nes_volume', String(val));
      } catch {}
      updateAudioControlsUI();
    });
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', () => initAudio(), { once: true });
    window.addEventListener('pointerdown', () => initAudio(), { once: true });
  }

  return { initAudio, pushSample };
}
