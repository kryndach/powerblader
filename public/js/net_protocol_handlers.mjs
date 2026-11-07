// Incoming WebSocket/WebRTC Protocol Message Dispatcher
import { base64ToUint8 } from './rom_sync.mjs';

export function createProtocolHandlers(
  state, ui, romSync, transport, telemetry
) {
  const { pushGameplayTelemetryToServer, handlePongAndAutoDelay } = telemetry;

  function sendWs(obj) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  function applyImportedSyncState(syncState, bannerText) {
    if (!syncState || !state.engine) return;
    state.engine.localPlayer = state.localPlayerIndex;
    state.engine.online = true;
    state.engine.inputDelayFrames = romSync.resolveDesiredInputDelay();
    state.engine.importSyncState(syncState, { preserveLocalInputDelay: true });
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

  function finalizeIncomingRomTransfer() {
    const xfer = state.incomingRomTransfer;
    if (!xfer) return;
    state.incomingRomTransfer = null;
    const full = new Uint8Array(xfer.totalBytes);
    let offset = 0;
    for (let i = 0; i < xfer.totalChunks; i++) {
      const part = xfer.chunks.get(i);
      if (!part) return;
      full.set(part, offset);
      offset += part.length;
    }
    romSync.loadRomFromUint8(full, xfer.romName, {
      broadcastToPeer: false,
      isAutoDefault: xfer.isAutoDefaultRom
    });
    state.partnerRomName = xfer.romName;
    state.partnerRomCrc32 = state.romCrc32;
    applyImportedSyncState(
      xfer.syncState,
      `ONLINE SYNCED - PLAYING "${state.romName}"`
    );
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
    } else {
      state.partnerRomName = null;
      state.partnerRomCrc32 = null;
    }

    if (state.engine) {
      state.engine.localPlayer = state.localPlayerIndex;
      state.engine.online = state.peerConnected;
      state.engine.enableRiftPacing = true;
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
      }
    }
    pushGameplayTelemetryToServer();
  }

  function handleIncomingNetMessage(msg) {
    if (msg.type === 'aux_bound') return;
    if (msg.type === 'netplay_input') {
      const firstIn = Array.isArray(msg.inputs) ? msg.inputs[0] : 0;
      const dedupKey =
        `${msg.sessionId || ''}:${msg.startFrame}:` +
        `${firstIn}:${msg.hashFrame || ''}`;
      if (dedupKey === state.lastRxInputDedupKey) return;
      state.lastRxInputDedupKey = dedupKey;
      state.rxCountThisSec++;
      const nowPerf = performance.now();
      if (state.lastRxInputAt > 0) {
        const gap = Math.round(nowPerf - state.lastRxInputAt);
        if (gap > state.maxRxGapMs && gap < 10000) state.maxRxGapMs = gap;
      }
      state.lastRxInputAt = nowPerf;
      if (state.engine && state.peerConnected) {
        state.engine.receiveRemoteInputPacket(msg, nowPerf);
      }
      return;
    }

    state.rxCountThisSec++;
    if (msg.type === 'peer_ping') {
      return sendWs({ type: 'peer_pong', t: msg.t });
    }
    if (
      msg.type === 'peer_pong' ||
      (msg.type === 'pong' && !state.peerConnected)
    ) {
      return handlePongAndAutoDelay(msg);
    }
    if (msg.type === 'room_joined') return handleRoomJoined(msg);

    if (msg.type === 'peer_joined') {
      state.peerConnected = true;
      state.peerNick = msg.peer?.nick || 'Partner';
      state.partnerRomName = msg.peer?.romName || state.partnerRomName;
      state.partnerRomCrc32 = msg.peer?.romCrc32 || state.partnerRomCrc32;
      state.matchStarted = false;
      if (state.engine) {
        state.engine.localPlayer = state.localPlayerIndex;
        state.engine.online = true;
        state.engine.enableRiftPacing = true;
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
      state.peerConnected = false;
      state.partnerRomName = null;
      state.partnerRomCrc32 = null;
      state.matchStarted = false;
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
        if (
          state.localPlayerIndex === 1 &&
          state.peerConnected &&
          state.romCrc32 &&
          state.partnerRomCrc32 === state.romCrc32
        ) {
          romSync.startLockstepMatchAtFrameZero('Partner selected same ROM');
        }
      }
      ui.updateStatusStrip();
      return pushGameplayTelemetryToServer();
    }

    if (msg.type === 'match_start_req') {
      if (
        state.romUint8 &&
        state.romBinaryString &&
        (!msg.romCrc32 || msg.romCrc32 === state.romCrc32)
      ) {
        state.partnerRomName = msg.romName || state.romName;
        state.partnerRomCrc32 = msg.romCrc32 || state.romCrc32;
        state.nes.loadROM(state.romBinaryString);
        state.engine.localPlayer = state.localPlayerIndex;
        state.engine.online = true;
        state.engine.enableRiftPacing = true;
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
      }
      return;
    }

    if (msg.type === 'match_start_ack' || msg.type === 'sync_ack') {
      if (
        state.engine &&
        (!msg.sessionId || msg.sessionId === state.engine.sessionId)
      ) {
        if (state.syncAckTimeout) {
          clearTimeout(state.syncAckTimeout);
          state.syncAckTimeout = null;
        }
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
      if (msg.haveCrc32 === state.romCrc32) {
        romSync.sendStateSyncToPeer({ resetToZero: false });
      } else {
        romSync.sendRomAndStateToPeer({ resetToZero: true });
      }
      return;
    }

    if (msg.type === 'rom_chunk_start') {
      state.incomingRomTransfer = {
        sessionId: msg.sessionId, romName: msg.romName, romCrc32: msg.romCrc32,
        isAutoDefaultRom: Boolean(msg.isAutoDefaultRom),
        totalBytes: msg.totalBytes, totalChunks: msg.totalChunks,
        syncState: msg.syncState, chunks: new Map(), endSeen: false
      };
      if (state.engine) state.engine.syncPaused = true;
      ui.showScreenBanner(`DOWNLOADING "${msg.romName}" (0%)...`, 'warn', 0);
      return ui.updateStatusStrip();
    }

    if (
      msg.type === 'rom_chunk_data' &&
      state.incomingRomTransfer &&
      msg.sessionId === state.incomingRomTransfer.sessionId
    ) {
      const xfer = state.incomingRomTransfer;
      xfer.chunks.set(msg.index, base64ToUint8(msg.dataB64));
      if (xfer.chunks.size >= xfer.totalChunks && xfer.endSeen) {
        finalizeIncomingRomTransfer();
      }
      return;
    }

    if (
      msg.type === 'rom_chunk_end' &&
      state.incomingRomTransfer &&
      msg.sessionId === state.incomingRomTransfer.sessionId
    ) {
      state.incomingRomTransfer.endSeen = true;
      const xfer = state.incomingRomTransfer;
      if (xfer.chunks.size >= xfer.totalChunks) finalizeIncomingRomTransfer();
      return;
    }

    if (msg.type === 'rom_sync') {
      const u8 = base64ToUint8(msg.romBase64);
      romSync.loadRomFromUint8(u8, msg.romName, {
        broadcastToPeer: false, isAutoDefault: Boolean(msg.isAutoDefaultRom)
      });
      state.partnerRomName = msg.romName;
      state.partnerRomCrc32 = state.romCrc32;
      return applyImportedSyncState(msg.syncState);
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

  return { handleIncomingNetMessage };
}
