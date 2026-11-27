// Live Gameplay Telemetry Builder, Auto-Delay Hysteresis & Debug Inspector
import { NesNetplayEngine } from '../../src/netplay_engine.mjs';
import { buildApiUrl } from './server_endpoint.mjs';

export function createTelemetryReporter(state, ui, romSync) {
  function buildGameplayTelemetryPayload() {
    const t = state.engine ? state.engine.getTelemetry() : {};
    const mode = ui.transportModeSelect?.value || 'auto';
    const usingP2P = Boolean(
      state.ws?.isServerlessP2p ||
      (state.rtcChannel && state.rtcChannel.readyState === 'open' &&
        (mode === 'p2p' || (mode === 'auto' && state._usingP2pAuto !== false)))
    );
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

  let telemetryPostInFlight = false;

  async function pushGameplayTelemetryToServer() {
    if (!state.ws || state.ws.readyState !== 1) return;
    if (state.ws.isServerlessP2p) return;
    if (state.isStaticOrigin && !state.apiBaseUrl) return;
    const telemetry = buildGameplayTelemetryPayload();
    if (typeof fetch === 'function') {
      if (telemetryPostInFlight) return;
      telemetryPostInFlight = true;
      try {
        await fetch(buildApiUrl(state, '/api/gameplay-telemetry'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(telemetry)
        });
      } catch {} finally {
        telemetryPostInFlight = false;
      }
      return;
    }
    try {
      const msg = { type: 'gameplay_telemetry_ws', telemetry };
      state.ws.send(JSON.stringify(msg));
    } catch {}
  }

  function handlePongAndAutoDelay(msg, src = 'wss') {
    const mode = ui.transportModeSelect?.value || 'auto';
    const rtcOpen = state.rtcChannel?.readyState === 'open';
    const isP2pMsg = Boolean(
      state.ws?.isServerlessP2p || src === 'p2p' || msg.via === 'p2p'
    );
    const sampleRtt = msg.type === 'wire_rtt'
      ? Math.max(1, Math.round(msg.rttMs || 1))
      : Math.max(1, Date.now() - msg.t);
    if (sampleRtt > 1500 || (state.engine?.syncPaused && sampleRtt > 500)) {
      return;
    }
    const nowPerf = performance.now();
    if (isP2pMsg) {
      state.p2pRttMs = sampleRtt;
      state.recordPathRtt?.('p2p', sampleRtt);
    } else {
      state.wssRttMs = sampleRtt;
      if (msg.type === 'wire_rtt') state._lastWireRttAt = nowPerf;
      state.recordPathRtt?.('wss', sampleRtt);
    }
    const p2pActive = Boolean(
      state.ws?.isServerlessP2p ||
      (rtcOpen && mode === 'p2p') ||
      (rtcOpen && mode === 'auto' && state._usingP2pAuto !== false &&
        !(state.wssRttMs > 0 && state.p2pRttMs > state.wssRttMs + 12))
    );
    if (msg.type === 'wire_rtt' && p2pActive) return;
    if (isP2pMsg && !p2pActive) return;
    if (
      msg.type === 'peer_pong' && !isP2pMsg && !p2pActive &&
      nowPerf - (state._lastWireRttAt || 0) < 5000
    ) {
      return;
    }
    if (!state._rttSamples) state._rttSamples = [];
    state._rttSamples.push(sampleRtt);
    if (state._rttSamples.length > 5) state._rttSamples.shift();
    const sorted = [...state._rttSamples].sort((a, b) => a - b);
    const medRtt = sorted[Math.floor(sorted.length * 0.5)];

    state.jitterMs = Math.round(
      state.jitterMs * 0.7 + Math.abs(sampleRtt - medRtt) * 0.3
    );
    state.rttMs = medRtt;
    ui.pingBadge.textContent = `Ping: ${state.rttMs}ms`;
    ui.dbgRtt.textContent = `${state.rttMs} ms / +/-${state.jitterMs} ms`;

    const isPeerSample =
      msg.type === 'peer_pong' ||
      (msg.type === 'wire_rtt' && state.peerConnected);
    if (
      isPeerSample &&
      ui.inputDelaySelect.value === 'auto' &&
      state.engine
    ) {
      const rawRec = NesNetplayEngine.computeRecommendedInputDelay(
        state.rttMs,
        state.jitterMs,
        state.engine.rxClumpFrames,
        state.engine.inputDelayFrames
      );
      const isArc = state.engine.core?.systemId === 'arcade';
      const hasShadow = Boolean(state.engine.shadowRollback?.isReady?.());
      const recDelay = !isArc ? rawRec
        : hasShadow ? Math.min(2, Math.max(1, rawRec))
        : Math.max(state.rttMs >= 160 ? 4 : 3, rawRec);
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
      const delta = Math.abs(recDelay - state.engine.inputDelayFrames);
      const inActiveMatch =
        !state.engine.syncPaused && (state.engine.currentFrame || 0) >= 90;
      const minStreak = inActiveMatch ? 8 : 3;
      const minCooldown = inActiveMatch ? 45000 : 12000;
      if (delta > 0 && (!inActiveMatch || delta >= 2)) {
        if (state.autoDelayCandidate === recDelay) {
          state.autoDelayStreak++;
        } else {
          state.autoDelayCandidate = recDelay;
          state.autoDelayStreak = 1;
        }
        const nowMs = performance.now();
        if (
          state.autoDelayStreak >= minStreak &&
          nowMs - state.lastAutoDelayChangeAt > minCooldown
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
