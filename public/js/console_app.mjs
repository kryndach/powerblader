// Main NES Netplay Console Application Entry Point
import { createConsoleUI } from './console_ui.mjs';
import { createAudioDrcEngine } from './audio_drc.mjs';
import { createRomSyncManager } from './rom_sync.mjs';
import { createNetTransport } from './webrtc_p2p.mjs';
import { createTelemetryReporter } from './telemetry_reporter.mjs';
import { createProtocolHandlers } from './net_protocol_handlers.mjs';
import { createSaveSlotsManager } from './save_slots.mjs';
import { createKeyBindingsManager } from './key_bindings.mjs';
import { createViewportAndSpeedController } from './viewport_and_speed.mjs';
import { setupRomDropAndPicker } from './rom_archive.mjs';
import { setupHostTunnelController } from './tunnel_ui.mjs';
import { startConsoleFrameLoop } from './frame_loop.mjs';
import {
  createConsoleState, resetPeerSessionState
} from './session_store.mjs';

const state = createConsoleState();

const ui = createConsoleUI(state);
const audio = createAudioDrcEngine({
  muteBtn: ui.muteBtn,
  volumeSlider: ui.volumeSlider,
  volumeValLabel: ui.volumeValLabel
});
window.__nesAudioStats = () => audio.getStats();

try {
  const savedDelay = localStorage.getItem('nes_input_delay');
  if (savedDelay !== null) {
    if (ui.topInputDelaySelect) ui.topInputDelaySelect.value = savedDelay;
    if (ui.inputDelaySelect) ui.inputDelaySelect.value = savedDelay;
  }
} catch {}

let protocol = null;
const transport = createNetTransport(state, ui, (msg, src) => {
  if (protocol) protocol.handleIncomingNetMessage(msg, src);
});
const romSync = createRomSyncManager(state, ui, audio);
const saveSlots = createSaveSlotsManager(state, ui, romSync);
const keyBindings = createKeyBindingsManager(state, ui);
const viewportCtrl = createViewportAndSpeedController(state, ui, romSync);
state.onRomLoaded = () => {
  viewportCtrl.applyOverclockToCore();
  saveSlots.updateSlotSelectLabels();
  if (!state.isAutoDefaultRom) viewportCtrl.centerGameScreen({ smooth: true });
};
state.onOverclockStateSynced = (en) => {
  viewportCtrl.setOverclockEnabled(en, {
    syncPeer: false, persist: false, showBanner: false
  });
};
state.onGameStarted = () => viewportCtrl.centerGameScreen({ smooth: true });
state.onRemoteSpeedCtrl = (mult) => {
  viewportCtrl.setSpeedMultiplier(mult, { broadcast: false, showBanner: true });
};
const telemetry = createTelemetryReporter(state, ui, romSync);
protocol = createProtocolHandlers(state, ui, romSync, transport, telemetry);

const params = new URLSearchParams(window.location.search);
if (params.get('room')) {
  ui.roomInput.value = params.get('room').toUpperCase().slice(0, 10);
}
if (params.get('nick')) {
  ui.nickInput.value = params.get('nick').slice(0, 14);
}
if (params.get('debug') === '1') {
  ui.debugDrawer.classList.add('open');
  ui.debugToggleBtn.classList.add('active-toggle');
}

function connectToRoom() {
  audio.initAudio();
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  if (state.wsAux) { try { state.wsAux.close(); } catch {} state.wsAux = null; }
  transport.closeWebRtc();

  const code = (ui.roomInput.value || 'NOVA').trim().toUpperCase().slice(0, 10);
  ui.roomInput.value = code;
  if (ui.autoBenchLink) {
    ui.autoBenchLink.href = `/autotest?gameRoom=${encodeURIComponent(code)}`;
  }
  const nick = (ui.nickInput.value || 'Player').trim().slice(0, 14);
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${window.location.host}/ws`;

  ui.dbgWssState.textContent = 'Connecting...';
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    ui.dbgWssState.textContent = 'Connected';
    ui.connectBtn.textContent = 'Reconnect';
    ws.send(
      JSON.stringify({
        type: 'join_room',
        roomCode: code,
        nick,
        romCrc32: state.romCrc32,
        romName: state.romName,
        isAutoDefaultRom: state.isAutoDefaultRom
      })
    );
  };

  ws.onmessage = (ev) => {
    try {
      protocol.handleIncomingNetMessage(JSON.parse(ev.data), 'wss');
    } catch {}
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    ui.dbgWssState.textContent = 'Disconnected';
    resetPeerSessionState(state, ui);
    if (state.wsAux) {
      try {
        state.wsAux.close();
      } catch {}
      state.wsAux = null;
    }
    transport.closeWebRtc();
    if (state.engine) {
      state.engine.online = false;
      state.engine.syncPaused = false;
    }
    ui.updateStatusStrip();
  };
}

ui.connectBtn.addEventListener('click', connectToRoom);
setupHostTunnelController(state, ui);

ui.resetBtn.addEventListener('click', () => {
  if (!state.nes || !state.engine) return;
  if (state.ws && state.ws.readyState === 1 && state.peerConnected) {
    if (state.partnerRomCrc32 === state.romCrc32) {
      romSync.startLockstepMatchAtFrameZero('Reset Button Clicked', true);
    } else {
      romSync.sendStateSyncToPeer({ resetToZero: true });
    }
  } else {
    state.nes.loadROM(state.romBinaryString);
    state.engine.resetTimeline(0);
    ui.logDebug('Console reset to frame #0.');
    ui.showScreenBanner(`CONSOLE RESET - "${state.romName}"`, 'ok', 2000);
  }
});

ui.startMatchNowBtn.addEventListener('click', () => {
  if (
    state.ws &&
    state.ws.readyState === 1 &&
    state.peerConnected &&
    state.romCrc32 &&
    state.partnerRomCrc32 === state.romCrc32
  ) {
    romSync.startLockstepMatchAtFrameZero('Start Match Button Clicked', true);
  }
});

function handleSendRomClick() {
  if (
    state.ws && state.ws.readyState === 1 &&
    state.peerConnected && state.romUint8 && state.engine
  ) {
    romSync.sendRomAndStateToPeer({ resetToZero: true });
  } else {
    ui.showScreenBanner('CONNECT TO PARTNER & LOAD ROM FIRST', 'warn', 2200);
  }
}
ui.sendRomManualBtn.addEventListener('click', handleSendRomClick);
if (ui.topSendRomBtn) {
  ui.topSendRomBtn.addEventListener('click', handleSendRomClick);
}

function applyInputDelaySelection(newValue) {
  if (ui.topInputDelaySelect && ui.topInputDelaySelect.value !== newValue) {
    ui.topInputDelaySelect.value = newValue;
  }
  if (ui.inputDelaySelect && ui.inputDelaySelect.value !== newValue) {
    ui.inputDelaySelect.value = newValue;
  }
  try {
    localStorage.setItem('nes_input_delay', newValue);
  } catch {}
  const nextDelay = romSync.resolveDesiredInputDelay();
  if (state.engine) state.engine.setInputDelay(nextDelay);
  const ms = Math.round(nextDelay * (1000 / 60.0988));
  const suffix = newValue === 'auto' ? ' [AUTO]' : '';
  ui.logDebug(`Local Input Delay set to ${nextDelay}f (${ms}ms)${suffix}`);
  ui.showScreenBanner(
    `LOCAL INPUT LAG: ${nextDelay}f (${ms}ms)${suffix}`,
    'ok',
    2200
  );
  telemetry.pushGameplayTelemetryToServer();
}

if (ui.topInputDelaySelect) {
  ui.topInputDelaySelect.addEventListener('change', () => {
    applyInputDelaySelection(ui.topInputDelaySelect.value);
  });
}
ui.inputDelaySelect.addEventListener('change', () => {
  applyInputDelaySelection(ui.inputDelaySelect.value);
});

ui.crtToggleBtn.addEventListener('click', () => {
  const enabled = ui.scanlinesOverlay.classList.toggle('enabled');
  ui.crtToggleBtn.textContent = enabled ? 'CRT: ON' : 'CRT: OFF';
  ui.crtToggleBtn.classList.toggle('active-toggle', enabled);
});

ui.debugToggleBtn.addEventListener('click', () => {
  ui.debugDrawer.classList.toggle('open');
  ui.debugToggleBtn.classList.toggle('active-toggle');
});

ui.forceResyncBtn.addEventListener('click', () => {
  if (!state.ws || state.ws.readyState !== 1 || !state.peerConnected) return;
  romSync.sendStateSyncToPeer({ resetToZero: false });
});

ui.copyTelemetryBtn.addEventListener('click', async () => {
  try {
    telemetry.pushGameplayTelemetryToServer();
    const res = await fetch('/api/gameplay-telemetry');
    if (res.ok) {
      const data = await res.json();
      const txt =
        data.session?.combinedText ||
        data.combinedText ||
        JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(txt);
      const orig = ui.copyTelemetryBtn.textContent;
      ui.copyTelemetryBtn.textContent = 'Copied!';
      setTimeout(() => (ui.copyTelemetryBtn.textContent = orig), 1500);
    }
  } catch (e) {
    ui.logDebug(`Copy telemetry failed: ${e.message}`);
  }
});

ui.simLagSlider.addEventListener('input', () => {
  state.simLagMs = Number(ui.simLagSlider.value);
  ui.dbgSimLabel.textContent = `${state.simLagMs}ms / ${state.simLossPct}%`;
});

ui.simLossSlider.addEventListener('input', () => {
  state.simLossPct = Number(ui.simLossSlider.value);
  ui.dbgSimLabel.textContent = `${state.simLagMs}ms / ${state.simLossPct}%`;
});

ui.localRomSelect.addEventListener('change', () => {
  if (ui.localRomSelect.value) {
    romSync.fetchLocalRomByName(ui.localRomSelect.value, {
      broadcastToPeer: true,
      isAutoDefault: false
    });
  }
});

setupRomDropAndPicker(state, ui, romSync);

ui.saveSlotSelect?.addEventListener('change', () =>
  saveSlots.selectSlot(Number(ui.saveSlotSelect.value), true)
);
ui.quickSaveBtn?.addEventListener('click', () =>
  saveSlots.saveToCurrentSlot()
);
ui.quickLoadBtn?.addEventListener('click', () =>
  saveSlots.loadFromCurrentSlot()
);
ui.exportSaveFileBtn?.addEventListener('click', () =>
  saveSlots.exportSaveToFile()
);
ui.importSaveFileBtn?.addEventListener('click', () =>
  ui.saveFileInput?.click()
);
ui.saveFileInput?.addEventListener('change', () => {
  const f = ui.saveFileInput.files?.[0];
  if (f) saveSlots.importSaveFromFile(f);
  ui.saveFileInput.value = '';
});

startConsoleFrameLoop(
  state, ui, transport, telemetry, saveSlots, keyBindings, viewportCtrl
);
ui.autoBenchLink?.addEventListener('click', () => {
  const c = (ui.roomInput.value || 'NOVA').trim().toUpperCase().slice(0, 10);
  ui.autoBenchLink.href = `/autotest?gameRoom=${encodeURIComponent(c)}`;
});
await romSync.discoverLocalRoms();
if (params.get('room')) connectToRoom();
