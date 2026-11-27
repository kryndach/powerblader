// 60 Hz Fixed-Timestep Loop, Sub-Frame Time-Sync & Input Polling
import { INPUT_BITS } from '../../src/netplay_engine.mjs';
import { encodeNetplayPacketBinary } from '../../src/binary_net_codec.mjs';

export const FRAME_DURATION_MS = 1000 / 60;

export function stepPacingAccumulator(
  accumulatorMs, dt, rift = 0, fromRaf = false
) {
  let effectiveFrameMs = FRAME_DURATION_MS;
  if (Math.abs(rift) > 0.25) {
    const scale = Math.max(-0.025, Math.min(0.025, rift * 0.007));
    effectiveFrameMs = FRAME_DURATION_MS * (1 + scale);
  }
  const nextAcc = fromRaf && dt >= 14.2 && dt <= 19.2 && Math.abs(rift) <= 0.25
    ? effectiveFrameMs
    : Math.min(accumulatorMs + dt, effectiveFrameMs * 2);
  return { accumulatorMs: nextAcc, effectiveFrameMs };
}

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

const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden',
  'image', 'radio', 'range', 'reset', 'submit'
]);

function isTextInputTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return !NON_TEXT_INPUT_TYPES.has((el.type || 'text').toLowerCase());
}

export function startConsoleFrameLoop(
  state, ui, transport, telemetry, saveSlots, keyBindings, viewportCtrl
) {
  let localButtonsMask = 0;

  window.addEventListener('keydown', (e) => {
    if (keyBindings && keyBindings.handleModalKeydown(e)) return;
    if (
      isTextInputTarget(document.activeElement) ||
      isTextInputTarget(e.target)
    ) {
      return;
    }
    if (!e.repeat && (e.code === 'F11' || (e.code === 'Enter' && e.altKey))) {
      e.preventDefault();
      if (viewportCtrl) viewportCtrl.toggleFullscreen();
      return;
    }
    if (keyBindings && keyBindings.isTurboHoldCode(e.code)) {
      e.preventDefault();
      if (!e.repeat && viewportCtrl) viewportCtrl.setHoldTurbo(true);
      return;
    }
    if (saveSlots && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.code === 'F6') {
        e.preventDefault();
        saveSlots.saveToCurrentSlot();
        return;
      }
      if (e.code === 'F8') {
        e.preventDefault();
        saveSlots.loadFromCurrentSlot();
        return;
      }
      if (e.code >= 'Digit1' && e.code <= 'Digit5') {
        e.preventDefault();
        saveSlots.selectSlot(Number(e.code.slice(-1)), true);
        return;
      }
    }
    const bit = keyBindings
      ? keyBindings.getBitForCode(e.code)
      : KEY_MAP[e.code];
    if (bit !== undefined) {
      e.preventDefault();
      localButtonsMask |= bit;
    }
  });

  window.addEventListener('keyup', (e) => {
    const typing =
      isTextInputTarget(document.activeElement) || isTextInputTarget(e.target);
    if (keyBindings && keyBindings.isTurboHoldCode(e.code)) {
      if (!typing) e.preventDefault();
      if (viewportCtrl && state.holdTurboActive) {
        viewportCtrl.setHoldTurbo(false);
      }
      return;
    }
    const bit = keyBindings
      ? keyBindings.getBitForCode(e.code)
      : KEY_MAP[e.code];
    if (bit !== undefined) {
      if (!typing) e.preventDefault();
      localButtonsMask &= ~bit;
    }
  });

  window.addEventListener('blur', () => {
    localButtonsMask = 0;
    if (viewportCtrl && state.holdTurboActive) {
      viewportCtrl.setHoldTurbo(false);
    }
  });

  let lastTickTime = performance.now();
  let lastRafAt = performance.now();
  let accumulatorMs = 0;
  let framesThisSec = 0;
  let lastDbgUiFrame = -99;
  let lastFpsUpdate = performance.now();
  let lastTelemetryTick = performance.now();

  function runTick(now, fromRaf = false) {
    const dt = Math.min(100, Math.max(0, now - lastTickTime));
    lastTickTime = now;

    let rift = 0;
    if (
      state.engine &&
      state.engine.online &&
      state.peerConnected &&
      !state.engine.syncPaused
    ) {
      rift = state.engine.riftFrames || 0;
    }
    const paced = stepPacingAccumulator(accumulatorMs, dt, rift, fromRaf);
    accumulatorMs = paced.accumulatorMs;
    const effectiveFrameMs = paced.effectiveFrameMs;

    let ticksInRaf = 0;
    while (accumulatorMs >= effectiveFrameMs) {
      accumulatorMs -= effectiveFrameMs;
      const stepStartMs = performance.now();
      if (state.nes && state.engine) {
        const effSpeed = viewportCtrl ? viewportCtrl.getEffectiveSpeed() : 1;
        const combinedMask =
          effSpeed > 1 ? 0 : localButtonsMask | pollGamepadMask();
        for (let s = 0; s < effSpeed; s++) {
          const isLast = s === effSpeed - 1;
          if (state.nes.ppu) state.nes.ppu._headlessFrame = !isLast;
          const res = state.engine.stepNetplayFrame(combinedMask, 0, {
            turboSpeed: effSpeed,
            skipRollback: s > 0 || ticksInRaf > 0,
            skipPacket: !isLast
          });
          if (state.nes.ppu) state.nes.ppu._headlessFrame = false;
          if (isLast && res.packetToSend && state.peerConnected) {
            transport.sendFastNetplayPacket(res.packetToSend);
          }
          if (res.stepped) framesThisSec++;
          const curF = state.engine.currentFrame;
          if (
            isLast &&
            (Math.abs(curF - lastDbgUiFrame) >= 4 || !res.stepped)
          ) {
            lastDbgUiFrame = curF;
            telemetry.updateDebugTelemetry(res.p1Mask, res.p2Mask);
          }
        }
      }
      ticksInRaf++;
      if (performance.now() - stepStartMs > 14.2) {
        accumulatorMs = Math.min(accumulatorMs, effectiveFrameMs * 0.5);
        break;
      }
    }

    if (now - lastFpsUpdate >= 1000) {
      state.lastFpsVal = framesThisSec;
      const eff = viewportCtrl ? viewportCtrl.getEffectiveSpeed() : 1;
      ui.fpsLabel.textContent =
        eff > 1 ? `${framesThisSec} FPS (${eff}x)` : `${framesThisSec} FPS`;
      state.txPerSec = state.txCountThisSec;
      state.rxPerSec = state.rxCountThisSec;
      state.txCountThisSec = 0;
      state.rxCountThisSec = 0;
      ui.dbgPktRate.textContent = `${state.txPerSec} / ${state.rxPerSec}`;
      framesThisSec = 0;
      lastFpsUpdate = now;

      const p2pOpen = state.rtcChannel?.readyState === 'open' &&
        ui.transportModeSelect?.value !== 'wss';
      if (p2pOpen) {
        try {
          state.rtcChannel.send(
            encodeNetplayPacketBinary({ type: 'peer_ping', t: Date.now() })
          );
        } catch {}
      }
      if (
        state.ws && state.ws.readyState === 1 &&
        (!state.peerConnected || now - (state._lastWireRttAt || 0) > 4500) &&
        (!p2pOpen || ui.transportModeSelect?.value === 'auto')
      ) {
        const pingType = state.peerConnected ? 'peer_ping' : 'ping';
        state.ws.send(JSON.stringify({ type: pingType, t: Date.now() }));
      }
    }

    if (now - lastTelemetryTick >= 8000) {
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

  try {
    const workerBlob = new Blob(['setInterval(() => postMessage(0), 6);'], {
      type: 'application/javascript'
    });
    const tickWorker = new Worker(URL.createObjectURL(workerBlob));
    tickWorker.onmessage = () => {
      const now = performance.now();
      if (document.hidden || now - lastRafAt > 50) runTick(now, false);
    };
  } catch {}

  function rafLoop(now) {
    lastRafAt = now;
    runTick(now, true);
    if (state.canvasDirty) {
      ui.ctx.putImageData(ui.imgData, 0, 0);
      state.canvasDirty = false;
    }
    requestAnimationFrame(rafLoop);
  }
  requestAnimationFrame(rafLoop);

  setInterval(() => {
    const now = performance.now();
    if (document.hidden && now - lastRafAt > 50) runTick(now, false);
  }, 16);
}
