// 60.0988 Hz NTSC Fixed-Timestep Loop, Sub-Frame Time-Sync & Input Polling
import { INPUT_BITS } from '/src/netplay_engine.mjs';

const KEY_MAP = {
  KeyZ: INPUT_BITS.A,
  KeyJ: INPUT_BITS.A,
  KeyX: INPUT_BITS.B,
  KeyK: INPUT_BITS.B,
  ShiftLeft: INPUT_BITS.SELECT,
  ShiftRight: INPUT_BITS.SELECT,
  Enter: INPUT_BITS.START,
  KeyW: INPUT_BITS.UP,
  ArrowUp: INPUT_BITS.UP,
  KeyS: INPUT_BITS.DOWN,
  ArrowDown: INPUT_BITS.DOWN,
  KeyA: INPUT_BITS.LEFT,
  ArrowLeft: INPUT_BITS.LEFT,
  KeyD: INPUT_BITS.RIGHT,
  ArrowRight: INPUT_BITS.RIGHT
};

function pollGamepadMask() {
  if (!navigator.getGamepads) return 0;
  const gp = navigator.getGamepads()?.[0];
  if (!gp) return 0;
  let m = 0;
  if (gp.buttons[0]?.pressed || gp.buttons[1]?.pressed) m |= INPUT_BITS.A;
  if (gp.buttons[2]?.pressed || gp.buttons[3]?.pressed) m |= INPUT_BITS.B;
  if (gp.buttons[8]?.pressed) m |= INPUT_BITS.SELECT;
  if (gp.buttons[9]?.pressed) m |= INPUT_BITS.START;
  if (gp.buttons[12]?.pressed || gp.axes[1] < -0.4) m |= INPUT_BITS.UP;
  if (gp.buttons[13]?.pressed || gp.axes[1] > 0.4) m |= INPUT_BITS.DOWN;
  if (gp.buttons[14]?.pressed || gp.axes[0] < -0.4) m |= INPUT_BITS.LEFT;
  if (gp.buttons[15]?.pressed || gp.axes[0] > 0.4) m |= INPUT_BITS.RIGHT;
  return m;
}

export function startConsoleFrameLoop(
  state, ui, transport, telemetry, saveSlots
) {
  let localButtonsMask = 0;

  window.addEventListener('keydown', (e) => {
    if (
      document.activeElement === ui.nickInput ||
      document.activeElement === ui.roomInput
    ) {
      return;
    }
    if (saveSlots && !e.repeat) {
      if (e.code === 'F5') {
        e.preventDefault();
        saveSlots.saveToCurrentSlot();
        return;
      }
      if (e.code === 'F8') {
        e.preventDefault();
        saveSlots.loadFromCurrentSlot();
        return;
      }
      if (
        e.code >= 'Digit1' &&
        e.code <= 'Digit5' &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        saveSlots.selectSlot(Number(e.code.slice(-1)), true);
        return;
      }
    }
    const bit = KEY_MAP[e.code];
    if (bit !== undefined) {
      e.preventDefault();
      localButtonsMask |= bit;
    }
  });

  window.addEventListener('keyup', (e) => {
    const bit = KEY_MAP[e.code];
    if (bit !== undefined) {
      e.preventDefault();
      localButtonsMask &= ~bit;
    }
  });

  const FRAME_DURATION_MS = 1000 / 60.0988;
  let lastTickTime = performance.now();
  let accumulatorMs = 0;
  let framesThisSec = 0;
  let lastFpsUpdate = performance.now();
  let lastTelemetryTick = performance.now();

  function runTick(now) {
    const dt = Math.min(100, Math.max(0, now - lastTickTime));
    lastTickTime = now;

    let effectiveFrameMs = FRAME_DURATION_MS;
    if (
      state.engine &&
      state.engine.online &&
      state.peerConnected &&
      !state.engine.syncPaused
    ) {
      const rift = state.engine.riftFrames || 0;
      if (Math.abs(rift) > 0.25) {
        const scale = Math.max(-0.03, Math.min(0.03, rift * 0.008));
        effectiveFrameMs = FRAME_DURATION_MS * (1 + scale);
      }
    }

    accumulatorMs = Math.min(accumulatorMs + dt, effectiveFrameMs * 2);

    while (accumulatorMs >= effectiveFrameMs) {
      accumulatorMs -= effectiveFrameMs;
      if (state.nes && state.engine) {
        const combinedMask = localButtonsMask | pollGamepadMask();
        const res = state.engine.stepNetplayFrame(combinedMask, 0);
        if (res.packetToSend && state.peerConnected) {
          transport.sendFastNetplayPacket(res.packetToSend);
        }
        if (res.stepped) framesThisSec++;
        if (state.engine.currentFrame % 4 === 0 || !res.stepped) {
          telemetry.updateDebugTelemetry(res.p1Mask, res.p2Mask);
        }
      }
    }

    if (now - lastFpsUpdate >= 1000) {
      state.lastFpsVal = framesThisSec;
      ui.fpsLabel.textContent = `${framesThisSec} FPS`;
      state.txPerSec = state.txCountThisSec;
      state.rxPerSec = state.rxCountThisSec;
      state.txCountThisSec = 0;
      state.rxCountThisSec = 0;
      ui.dbgPktRate.textContent = `${state.txPerSec} / ${state.rxPerSec}`;
      framesThisSec = 0;
      lastFpsUpdate = now;

      if (state.ws && state.ws.readyState === 1) {
        const pingType = state.peerConnected ? 'peer_ping' : 'ping';
        state.ws.send(JSON.stringify({ type: pingType, t: Date.now() }));
      }
    }

    if (now - lastTelemetryTick >= 2000) {
      lastTelemetryTick = now;
      if (state.ws && state.ws.readyState === 1) {
        const t = state.engine ? state.engine.getTelemetry() : {};
        state.telemetrySamples.push({
          ts: new Date().toISOString().slice(11, 19),
          frame: t.currentFrame ?? 0,
          fps: state.lastFpsVal,
          rtt: state.rttMs,
          rift: t.riftFrames ?? 0,
          adv: t.frameAdvantage ?? 0,
          rbSec: t.rollbacksPerSec ?? 0,
          maxRb: t.maxRollbackDepthSeen ?? 0,
          stalls: t.stallFrames ?? 0,
          stepMs: t.lastStepMs ?? 0,
          tx: state.txPerSec,
          rx: state.rxPerSec,
          maxGap: state.maxRxGapMs,
          sync:
            t.syncStatus ||
            (state.engine && state.engine.syncPaused ? 'PAUSED' : 'IDLE')
        });
        if (state.telemetrySamples.length > 30) state.telemetrySamples.shift();
        telemetry.pushGameplayTelemetryToServer();
      }
    }
  }

  let workerTimerActive = false;
  try {
    const workerBlob = new Blob(['setInterval(() => postMessage(0), 4);'], {
      type: 'application/javascript'
    });
    const tickWorker = new Worker(URL.createObjectURL(workerBlob));
    tickWorker.onmessage = () => {
      workerTimerActive = true;
      runTick(performance.now());
    };
  } catch {}

  function rafLoop(now) {
    if (!workerTimerActive) runTick(now);
    if (state.canvasDirty) {
      ui.ctx.putImageData(ui.imgData, 0, 0);
      state.canvasDirty = false;
    }
    requestAnimationFrame(rafLoop);
  }
  requestAnimationFrame(rafLoop);

  setInterval(() => {
    if (!workerTimerActive && (document.hidden || !document.hasFocus())) {
      runTick(performance.now());
    }
  }, 16);
}
