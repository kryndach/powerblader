// Incoming WebSocket/WebRTC Protocol Message Dispatcher
import { base64ToUint8 } from './rom_sync.mjs';
import { handleRomTransferMessage } from './rom_archive.mjs';
import { getCachedRomByCrc } from './rom_fast_transfer.mjs';
import { createInputRouter } from './input_router.mjs';
import {
  clearActiveRomTransfers, resetPingWindow, resetPeerSessionState
} from './session_store.mjs';

export function createProtocolHandlers(
  state, ui, romSync, transport, telemetry
) {
  const { pushGameplayTelemetryToServer, handlePongAndAutoDelay } = telemetry;
  const inputRouter = createInputRouter(state);

  function sendWs(obj) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  function clearTransfers() { clearActiveRomTransfers(state, ui); }

  function maybeAutoLoadCachedPartnerRom(crc, romName, forceOnP2 = false) {
    if (!crc || crc === state.romCrc32 || state.loadingCachedRomCrc === crc) {
      return;
    }
    const allow = forceOnP2 || state.localPlayerIndex === 2 ||
      state.isAutoDefaultRom || !state.romUint8;
    if (!allow) return;
    state.loadingCachedRomCrc = crc;
    getCachedRomByCrc(crc).then(async (hit) => {
      if (!hit?.u8 || state.romCrc32 === crc) return;
      ui.logDebug?.(
        `ROM CRC32 ${crc} cache hit (${hit.source || 'cache'}) - 0 KB!`
      );
      await romSync.loadRomFromUint8(hit.u8, romName || hit.romName, {
        broadcastToPeer: true, isAutoDefault: false, fromCache: true
      });
    }).finally(() => {
      if (state.loadingCachedRomCrc === crc) state.loadingCachedRomCrc = null;
    });
  }

  function applyImportedSyncState(syncState, bannerText) {
    if (!syncState || !state.engine) return;
    clearTransfers();
    state.engine.localPlayer = state.localPlayerIndex;
    state.engine.online = true;
    state.engine.enableRiftPacing = false;
    state.engine.inputDelayFrames = romSync.resolveDesiredInputDelay();
    if (syncState.resetToZero && state.nes && state.romBinaryString) {
      state.nes.loadROM(state.romBinaryString);
      if (typeof syncState.overclockEnabled === 'boolean') {
        state.onOverclockStateSynced?.(syncState.overclockEnabled);
      }
      state.engine.resetTimeline(0, syncState.sessionId);
    } else {
      state.engine.importSyncState(
        syncState, { preserveLocalInputDelay: true }
      );
      if (state.nes && state.nes.ppu) {
        const oc = Boolean(state.nes.ppu._overclockEnabled);
        state.onOverclockStateSynced?.(oc);
      }
    }
    state.engine.syncPaused = false;
    state.matchStarted = true;
    sendWs({
      type: 'sync_ack', sessionId: state.engine.sessionId,
      frame: state.engine.currentFrame, romCrc32: state.romCrc32
    });
    if (bannerText) ui.showScreenBanner(bannerText, 'ok', 3500);
    if (typeof state.onGameStarted === 'function') state.onGameStarted();
    ui.updateStatusStrip();
  }

  function sendLocalRomStatus() {
    if (!state.romCrc32) return;
    sendWs({
      type: 'rom_status', romCrc32: state.romCrc32,
      romName: state.romName, isAutoDefaultRom: false
    });
  }

  function handleRoomJoined(msg) {
    state.roomCode = msg.roomCode;
    state.localClientId = msg.clientId || null;
    state.localPlayerIndex = msg.playerIndex;
    transport.connectAuxWebSocket(state.roomCode, state.localClientId);
    const otherPeers = (msg.peers || []).filter(
      (p) => p.playerIndex !== state.localPlayerIndex
    );
    state.peerConnected = otherPeers.length > 0;
    state.matchStarted = false;

    if (state.peerConnected) {
      const partner = otherPeers[0];
      state.peerNick = partner.nick || `Player ${partner.playerIndex}`;
      state.partnerRomName = partner.romName || null;
      state.partnerRomCrc32 = partner.romCrc32 || null;
      state.routeOptimizer?.onPeerJoined?.(partner);
    } else {
      state.partnerRomName = null;
      state.partnerRomCrc32 = null;
    }

    if (state.engine) {
      state.engine.localPlayer = state.localPlayerIndex;
      state.engine.online = state.peerConnected;
      state.engine.enableRiftPacing = false;
      state.engine.resetTimeline(0);
      if (state.peerConnected) state.engine.syncPaused = true;
    }

    ui.logDebug(
      `Joined room "${state.roomCode}" as P${state.localPlayerIndex}`
    );
    ui.updateStatusStrip();

    if (!state.peerConnected) {
      ui.showScreenBanner(
        `ROOM "${state.roomCode}" READY - Waiting for Player 2`, 'warn', 0
      );
    } else {
      ui.showScreenBanner(
        `CONNECTED TO ${state.peerNick.toUpperCase()}`, 'ok', 3500
      );
      sendLocalRomStatus();
      if (
        state.localPlayerIndex === 1 &&
        state.romCrc32 &&
        state.partnerRomCrc32 === state.romCrc32
      ) {
        romSync.startLockstepMatchAtFrameZero('Joined with matching ROMs');
      } else {
        maybeAutoLoadCachedPartnerRom(
          state.partnerRomCrc32, state.partnerRomName
        );
      }
    }
    pushGameplayTelemetryToServer();
  }

  function handleIncomingNetMessage(msg) {
    if (msg.type === 'aux_bound') return;
    if (msg.type === 'auth_required') {
      ui.dbgWssState.textContent = 'Auth Failed';
      return ui.showScreenBanner(
        `PASSWORD REQUIRED (${msg.reason || 'Check Pass'})`, 'err', 5000
      );
    }
    if (msg.type.startsWith('route_')) {
      return state.routeOptimizer?.handleRouteMessage?.(msg);
    }
    if (msg.type === 'netplay_input') {
      return inputRouter.routeNetplayInput(msg);
    }

    state.rxCountThisSec++;
    if (msg.type === 'peer_ping') {
      return sendWs({ type: 'peer_pong', t: msg.t });
    }
    if (
      msg.type === 'wire_rtt' || msg.type === 'peer_pong' ||
      (msg.type === 'pong' && !state.peerConnected)
    ) {
      return handlePongAndAutoDelay(msg);
    }
    if (msg.type === 'room_joined') return handleRoomJoined(msg);

    if (msg.type === 'peer_joined') {
      state.peerConnected = true;
      resetPingWindow(state);
      state.peerNick = msg.peer?.nick || 'Partner';
      state.partnerRomName = msg.peer?.romName || state.partnerRomName;
      state.partnerRomCrc32 = msg.peer?.romCrc32 || state.partnerRomCrc32;
      state.matchStarted = false;
      state.routeOptimizer?.onPeerJoined?.(msg.peer);
      if (state.engine) {
        state.engine.localPlayer = state.localPlayerIndex;
        state.engine.online = true;
        state.engine.enableRiftPacing = false;
        state.engine.syncPaused = true;
      }
      ui.updateStatusStrip();
      sendLocalRomStatus();
      if (state.localPlayerIndex === 1) {
        transport.startWebRtcSession(true);
        if (state.romCrc32 && state.partnerRomCrc32 === state.romCrc32) {
          romSync.startLockstepMatchAtFrameZero('Partner joined with same ROM');
        }
      }
      return pushGameplayTelemetryToServer();
    }

    if (msg.type === 'peer_left') {
      resetPeerSessionState(state, ui);
      transport.closeWebRtc();
      if (state.engine) {
        state.engine.online = false;
        state.engine.syncPaused = false;
      }
      ui.showScreenBanner(
        `PARTNER LEFT ROOM "${state.roomCode}"`, 'warn', 4000
      );
      ui.updateStatusStrip();
      return pushGameplayTelemetryToServer();
    }

    if (msg.type === 'rom_status' || msg.type === 'rom_info') {
      const crcChanged = state.partnerRomCrc32 !== (msg.romCrc32 || null);
      state.partnerRomName = msg.romName || null;
      state.partnerRomCrc32 = msg.romCrc32 || null;
      if (crcChanged || !state.matchStarted) {
        state.matchStarted = false;
        if (state.engine && state.peerConnected) state.engine.syncPaused = true;
        if (state.localPlayerIndex === 1 && state.peerConnected &&
            state.romCrc32 && state.partnerRomCrc32 === state.romCrc32) {
          romSync.startLockstepMatchAtFrameZero('Partner selected same ROM');
        } else {
          maybeAutoLoadCachedPartnerRom(
            state.partnerRomCrc32, state.partnerRomName
          );
        }
      }
      ui.updateStatusStrip();
      return pushGameplayTelemetryToServer();
    }

    if (msg.type === 'match_start_req') {
      if (state.romUint8 && state.romBinaryString &&
          (!msg.romCrc32 || msg.romCrc32 === state.romCrc32)) {
        clearTransfers();
        state.partnerRomName = msg.romName || state.romName;
        state.partnerRomCrc32 = msg.romCrc32 || state.romCrc32;
        state.nes.loadROM(state.romBinaryString);
        if (typeof msg.overclockEnabled === 'boolean') {
          state.onOverclockStateSynced?.(msg.overclockEnabled);
        }
        state.engine.localPlayer = state.localPlayerIndex;
        state.engine.online = true;
        state.engine.enableRiftPacing = false;
        state.engine.inputDelayFrames = romSync.resolveDesiredInputDelay();
        state.engine.resetTimeline(0, msg.sessionId);
        state.engine.syncPaused = false;
        state.matchStarted = true;
        state.lastRxInputAt = 0;
        state.maxRxGapMs = 0;
        sendWs({
          type: 'match_start_ack', sessionId: msg.sessionId,
          romCrc32: state.romCrc32
        });
        ui.showScreenBanner(
          `ONLINE LOCKSTEP STARTED - "${state.romName}"`, 'ok', 3500
        );
        if (typeof state.onGameStarted === 'function') state.onGameStarted();
        ui.updateStatusStrip();
        pushGameplayTelemetryToServer();
      } else if (msg.romCrc32 && msg.romCrc32 !== state.romCrc32) {
        sendWs({ type: 'rom_request', haveCrc32: state.romCrc32 });
      }
      return;
    }

    if (msg.type === 'match_start_ack' || msg.type === 'sync_ack') {
      if (state.engine &&
          (!msg.sessionId || msg.sessionId === state.engine.sessionId)) {
        if (state.syncAckTimeout) {
          clearTimeout(state.syncAckTimeout);
          state.syncAckTimeout = null;
        }
        clearTransfers();
        state.engine.syncPaused = false;
        state.matchStarted = true;
        state.lastRxInputAt = 0;
        state.maxRxGapMs = 0;
        ui.showScreenBanner(
          `ONLINE SYNCED - PLAYING "${state.romName}"`, 'ok', 3500
        );
        if (typeof state.onGameStarted === 'function') state.onGameStarted();
        ui.updateStatusStrip();
        pushGameplayTelemetryToServer();
      }
      return;
    }

    if (msg.type === 'rom_request' && state.romUint8) {
      if (msg.haveCrc32 && msg.haveCrc32 === state.romCrc32 &&
          !msg.forceChunks) {
        romSync.sendStateSyncToPeer({ resetToZero: false });
      } else {
        romSync.sendRomAndStateToPeer({
          resetToZero: true, forceChunks: Boolean(msg.forceChunks)
        });
      }
      return;
    }

    if (handleRomTransferMessage(
      msg, state, ui, romSync, applyImportedSyncState, sendWs, base64ToUint8
    )) {
      return;
    }

    if (msg.type === 'rom_sync') {
      const u8 = base64ToUint8(msg.romBase64);
      const opts = {
        broadcastToPeer: false, isAutoDefault: Boolean(msg.isAutoDefaultRom)
      };
      Promise.resolve(romSync.loadRomFromUint8(u8, msg.romName, opts)).then(
        () => {
          state.partnerRomName = msg.romName;
          state.partnerRomCrc32 = state.romCrc32;
          applyImportedSyncState(msg.syncState);
        }
      );
      return;
    }

    if (msg.type === 'state_sync') {
      if (state.engine && (!msg.romCrc32 || msg.romCrc32 === state.romCrc32)) {
        state.partnerRomName = msg.romName || state.romName;
        state.partnerRomCrc32 = msg.romCrc32 || state.romCrc32;
        applyImportedSyncState(msg.syncState);
      } else if (msg.romCrc32 && msg.romCrc32 !== state.romCrc32) {
        sendWs({ type: 'rom_request', haveCrc32: state.romCrc32 });
      }
      return;
    }

    if (msg.type === 'speed_ctrl' && state.onRemoteSpeedCtrl) {
      return state.onRemoteSpeedCtrl(msg.mult);
    }
    if (msg.type === 'resync_request' && state.localPlayerIndex === 1) {
      return romSync.sendStateSyncToPeer({ resetToZero: false });
    }
    if (msg.type === 'console_reset' && state.nes && state.engine) {
      return romSync.startLockstepMatchAtFrameZero('Partner Reset');
    }
    if (msg.type === 'webrtc_signal') {
      transport.handleWebRtcSignal(msg.signal);
    }
  }

  return { handleIncomingNetMessage, maybeAutoLoadCachedPartnerRom };
}
