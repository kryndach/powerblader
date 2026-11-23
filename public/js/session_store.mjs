// Centralized Frontend Console Session State Factory & Transition Helpers
export function createConsoleState() {
  return {
    nes: null,
    engine: null,
    romBinaryString: null,
    romUint8: null,
    romName: null,
    romCrc32: null,
    isAutoDefaultRom: false,
    customRomsMap: new Map(),
    ws: null,
    wsAux: null,
    localClientId: null,
    rxInputDedupSet: new Set(),
    rtcPeer: null,
    rtcChannel: null,
    roomCode: null,
    localPlayerIndex: 1,
    peerConnected: false,
    peerNick: 'Player 2',
    partnerRomName: null,
    partnerRomCrc32: null,
    matchStarted: false,
    syncAckTimeout: null,
    activeRomAbortCtrl: null,
    activeRomDownload: null,
    incomingRomTransfer: null,
    sendingRomSessionId: null,
    lastAutoResyncTime: 0,
    rttMs: 0,
    jitterMs: 0,
    _rttSamples: [],
    _lastWireRttAt: 0,
    autoDelayCandidate: 3,
    autoDelayStreak: 0,
    lastAutoDelayChangeAt: 0,
    txCountThisSec: 0,
    rxCountThisSec: 0,
    txPerSec: 0,
    rxPerSec: 0,
    lastFpsVal: 0,
    lastRxInputAt: 0,
    maxRxGapMs: 0,
    simLagMs: 0,
    simLossPct: 0,
    nesOverclockEnabled: false,
    canvasDirty: false,
    telemetrySamples: [],
    telemetryEvents: []
  };
}

export function resetPingWindow(state) {
  state._rttSamples = [];
  state.rttMs = 0;
  state.jitterMs = 0;
  state._lastWireRttAt = 0;
}

export function clearActiveRomTransfers(state, ui) {
  state.activeRomAbortCtrl?.abort();
  state.activeRomAbortCtrl = null;
  state.activeRomDownload = null;
  state.incomingRomTransfer = null;
  state.sendingRomSessionId = null;
  ui?.resetSendRomButtons?.();
}

export function resetPeerSessionState(state, ui) {
  clearActiveRomTransfers(state, ui);
  state.peerConnected = false;
  state.partnerRomName = null;
  state.partnerRomCrc32 = null;
  state.matchStarted = false;
  resetPingWindow(state);
}
