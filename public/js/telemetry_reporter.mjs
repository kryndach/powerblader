// Live Gameplay Telemetry Builder, Auto-Delay Hysteresis & Debug Inspector
import { NesNetplayEngine } from '/src/netplay_engine.mjs';

export function createTelemetryReporter(state, ui, romSync) {
  function buildGameplayTelemetryPayload() {
    const t = state.engine ? state.engine.getTelemetry() : {};
    const usingP2P =
      state.rtcChannel &&
      state.rtcChannel.readyState === 'open' &&
      ui.transportModeSelect.value !== 'wss';
    const matchState =
      !state.ws || state.ws.readyState !== 1
        ? 'OFFLINE_SOLO'
        : !state.peerConnected
        ? 'WAITING_FOR_PARTNER'
        : !state.romCrc32 || !state.partnerRomCrc32
        ? 'SELECTING_ROM'
        : state.romCrc32 !== state.partnerRomCrc32
        ? 'ROM_MISMATCH'
        : state.engine && state.engine.syncPaused
        ? 'LOCKSTEP_BARRIER'
        : 'PLAYING_LOCKSTEP';

    const transportName = usingP2P
      ? 'WebRTC P2P'
      : state.ws && state.ws.readyState === 1
      ? 'WSS Relay'
      : 'Offline';

    return {
      playerIndex: state.localPlayerIndex,
      roomCode: state.roomCode || 'SOLO',
      transport: transportName,
      romName: state.romName || 'None',
      romCrc32: state.romCrc32 || '--',
      partnerRomCrc32: state.partnerRomCrc32 || '--',
      matchState,
      currentFrame: t.currentFrame ?? 0,
      lastVerifiedFrame: t.lastVerifiedFrame ?? -1,
      syncStatus: t.syncStatus || 'IDLE',
      desyncCount: t.desyncCount ?? 0,
      rttMs: state.rttMs,
      jitterMs: state.jitterMs,
      riftFrames: t.riftFrames ?? 0,
      riftWaitFrames: t.riftWaitFrames ?? 0,
      clumpBiasFrames: t.clumpBiasFrames ?? 0,
      rxGapP95Ms: t.rxGapP95Ms ?? 0,
      rxClumpFrames: t.rxClumpFrames ?? 0,
      smoothedFramesCount: t.smoothedFramesCount ?? 0,
      inputDelayFrames:
        t.inputDelayFrames ?? Number(ui.inputDelaySelect.value),
      fps: state.lastFpsVal,
      lastStepMs: t.lastStepMs ?? 0,
      rollbacksPerSec: t.rollbacksPerSec ?? 0,
      rollbacksTotal: t.rollbacksTotal ?? 0,
      lastRollbackDepth: t.lastRollbackDepth ?? 0,
      maxRollbackDepthSeen: t.maxRollbackDepthSeen ?? 0,
      frameAdvantage: t.frameAdvantage ?? 0,
      stallFrames: t.stallFrames ?? 0,
      txPerSec: state.txPerSec,
      rxPerSec: state.rxPerSec,
      maxRxGapMs: state.maxRxGapMs,
      samples: state.telemetrySamples.slice(-12),
      events: state.telemetryEvents.slice(-15)
    };
  }

  function pushGameplayTelemetryToServer() {
    const sock =
      state.ws2 && state.ws2.readyState === 1 ? state.ws2 : state.ws;
    if (!sock || sock.readyState !== 1) return;
    try {
      const telemetry = buildGameplayTelemetryPayload();
      const payload = JSON.stringify({
        type: 'gameplay_telemetry_ws',
        telemetry
      });
      sock.send(payload);
    } catch {}
  }

  function handlePongAndAutoDelay(msg) {
    const sampleRtt = Math.max(1, Date.now() - msg.t);
    state.jitterMs = Math.round(
      state.jitterMs * 0.7 + Math.abs(sampleRtt - state.rttMs) * 0.3
    );
    state.rttMs = Math.round(
      state.rttMs === 0 ? sampleRtt : state.rttMs * 0.7 + sampleRtt * 0.3
    );
    ui.pingBadge.textContent = `Ping: ${state.rttMs}ms`;
    ui.dbgRtt.textContent = `${state.rttMs} ms / +/-${state.jitterMs} ms`;

    if (
      msg.type === 'peer_pong' &&
      ui.inputDelaySelect.value === 'auto' &&
      state.engine
    ) {
      const recDelay = NesNetplayEngine.computeRecommendedInputDelay(
        state.rttMs,
        state.jitterMs,
        state.engine.rxClumpFrames,
        state.engine.inputDelayFrames
      );
      const autoOpt = ui.inputDelaySelect.querySelector('option[value="auto"]');
      if (autoOpt) {
        autoOpt.textContent = `Auto (${recDelay}f @ ${state.rttMs}ms)`;
      }
      if (ui.topInputDelaySelect) {
        const topOpt = ui.topInputDelaySelect.querySelector(
          'option[value="auto"]'
        );
        if (topOpt) topOpt.textContent = `Lag: Auto (${recDelay}f)`;
      }
      if (recDelay !== state.engine.inputDelayFrames) {
        if (state.autoDelayCandidate === recDelay) {
          state.autoDelayStreak++;
        } else {
          state.autoDelayCandidate = recDelay;
          state.autoDelayStreak = 1;
        }
        const nowMs = performance.now();
        if (
          state.autoDelayStreak >= 3 &&
          nowMs - state.lastAutoDelayChangeAt > 12000
        ) {
          state.lastAutoDelayChangeAt = nowMs;
          state.autoDelayStreak = 0;
          state.engine.setInputDelay(recDelay);
          ui.logDebug(`Auto Input Delay adjusted to ${recDelay}f`);
        }
      } else {
        state.autoDelayStreak = 0;
      }
    }
  }

  function updateDebugTelemetry(p1Mask, p2Mask) {
    ui.updateMiniPads(p1Mask, p2Mask);
    if (!state.engine) return;

    if (
      state.peerConnected &&
      !state.engine.syncPaused &&
      state.engine.syncStatus === 'DESYNC' &&
      state.localPlayerIndex === 1 &&
      performance.now() - state.lastAutoResyncTime > 3000
    ) {
      state.lastAutoResyncTime = performance.now();
      ui.logDebug('Desync detected - triggering automatic state resync...');
      romSync.sendStateSyncToPeer({ resetToZero: false });
    }

    if (!ui.debugDrawer.classList.contains('open')) return;
    const t = state.engine.getTelemetry();
    ui.dbgFrame.textContent = String(t.currentFrame);
    ui.dbgVerifiedFrame.textContent =
      t.lastVerifiedFrame >= 0 ? String(t.lastVerifiedFrame) : '--';
    ui.dbgLocalHash.textContent = t.lastLocalHash;
    ui.dbgRemoteHash.textContent = t.lastRemoteHash;
    ui.dbgDesyncs.textContent = String(t.desyncCount);

    if (t.syncStatus === 'SYNC_OK') {
      ui.dbgSyncBadge.className = 'badge ok';
      ui.dbgSyncBadge.textContent = 'SYNC OK';
    } else {
      ui.dbgSyncBadge.className = 'badge err';
      ui.dbgSyncBadge.textContent = 'DESYNC!';
    }

    ui.dbgStepTime.textContent = `${t.lastStepMs}ms/f`;
    ui.dbgRollbacks.textContent =
      `${t.rollbacksPerSec}/s (${t.rollbacksTotal})`;
    ui.dbgRbDepth.textContent =
      `${t.lastRollbackDepth}f / ${t.maxRollbackDepthSeen}f`;
    ui.dbgAdvantage.textContent =
      `${t.frameAdvantage}f / ${t.stallFrames} stalls`;
    if (ui.dbgRift) {
      const sign = t.riftFrames >= 0 ? '+' : '';
      ui.dbgRift.textContent =
        `${sign}${t.riftFrames}f / ${t.riftWaitFrames} waits`;
    }
    ui.dbgP1Hex.textContent =
      '0x' + p1Mask.toString(16).toUpperCase().padStart(2, '0');
    ui.dbgP2Hex.textContent =
      '0x' + p2Mask.toString(16).toUpperCase().padStart(2, '0');
    for (const btn of ui.dbgP1Btns) {
      btn.classList.toggle('lit', (p1Mask & Number(btn.dataset.bit)) !== 0);
    }
    for (const btn of ui.dbgP2Btns) {
      btn.classList.toggle('lit', (p2Mask & Number(btn.dataset.bit)) !== 0);
    }
  }

  return {
    pushGameplayTelemetryToServer,
    handlePongAndAutoDelay,
    updateDebugTelemetry
  };
}
