// Room Session Manager, Dual-WebSocket Striping & Message Relay
const FORWARD_TYPES = new Set([
  'netplay_input', 'state_sync', 'sync_ack', 'resync_request', 'console_reset',
  'rom_info', 'rom_status', 'rom_request', 'rom_sync', 'webrtc_signal',
  'peer_ping', 'peer_pong', 'state', 'event', 'warp_request', 'warp_snapshot'
]);

const normCode = (raw) =>
  String(raw || 'NOVA').trim().toUpperCase().slice(0, 12);

export function createRoomManager(trackers, options = {}) {
  const rooms = new Map();
  const {
    autotestSession, gameplayTelemetrySession, recordAccess,
    saveGameplayTelemetryToDisk, saveAutotestReportToDisk
  } = trackers;

  function getOrCreateRoom(roomCode) {
    if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
    return rooms.get(roomCode);
  }

  function formatPeerInfo(peer) {
    return {
      clientId: peer.clientId, playerIndex: peer.playerIndex, nick: peer.nick,
      romCrc32: peer.romCrc32, romName: peer.romName,
      isAutoDefaultRom: Boolean(peer.isAutoDefaultRom),
      wsOpen: Boolean(peer.ws?.readyState === 1),
      httpActive: Boolean(peer.httpActive)
    };
  }

  function getRoomPeersInfo(roomCode) {
    const roomMap = rooms.get(roomCode);
    return roomMap ? Array.from(roomMap.values(), formatPeerInfo) : [];
  }

  function sendToPeer(peer, payloadObj) {
    const msgWithSeq = { ...payloadObj, _seq: peer.nextSeq++ };
    const raw = JSON.stringify(msgWithSeq);
    let sentViaWs = false;
    if (peer.ws?.readyState === 1) {
      try { peer.ws.send(raw); peer.lastTxAt = Date.now(); sentViaWs = true; }
      catch {}
    }
    if (payloadObj.type === 'netplay_input' && peer.wsAux?.readyState === 1) {
      try {
        peer.wsAux.send(raw);
        peer.lastTxAt = Date.now();
        sentViaWs = true;
      } catch {}
    }
    if (sentViaWs) return;
    peer.httpOutbox.push(msgWithSeq);
    if (peer.httpOutbox.length > 400) peer.httpOutbox.shift();
  }

  function broadcastToRoom(roomCode, senderClientId, payloadObj) {
    const roomMap = rooms.get(roomCode);
    if (!roomMap) return;
    for (const peer of roomMap.values()) {
      if (peer.clientId !== senderClientId) sendToPeer(peer, payloadObj);
    }
  }

  function joinOrUpdatePeerSession(
    roomCodeRaw,
    clientIdRaw,
    info = {},
    wsInstance = null
  ) {
    const roomCode = normCode(roomCodeRaw);
    const randSuffix = Math.random().toString(36).slice(2, 7);
    const clientId = String(clientIdRaw || `c_${Date.now()}_${randSuffix}`);
    const roomMap = getOrCreateRoom(roomCode);

    let peer = roomMap.get(clientId);
    const isNewJoin = !peer;

    if (!peer) {
      if (roomMap.size >= 2) {
        for (const [existingCid, existingPeer] of roomMap.entries()) {
          if (existingPeer.ws?.readyState !== 1) {
            roomMap.delete(existingCid);
            break;
          }
        }
      }
      const usedIndices = new Set(
        Array.from(roomMap.values(), (p) => p.playerIndex)
      );
      peer = {
        clientId,
        roomCode,
        playerIndex: usedIndices.has(1) ? 2 : 1,
        nick: String(info.nick || 'Player').slice(0, 20),
        romCrc32: info.romCrc32 || null,
        romName: info.romName || null,
        isAutoDefaultRom:
          typeof info.isAutoDefaultRom === 'boolean'
            ? info.isAutoDefaultRom
            : true,
        ws: wsInstance || null,
        httpActive: Boolean(info.httpActive),
        httpOutbox: [],
        nextSeq: 1,
        lastSeenAt: Date.now()
      };
      roomMap.set(clientId, peer);
    } else {
      peer.lastSeenAt = Date.now();
      if (info.nick) peer.nick = String(info.nick).slice(0, 20);
      if (info.romCrc32 !== undefined) peer.romCrc32 = info.romCrc32;
      if (info.romName !== undefined) peer.romName = info.romName;
      if (typeof info.isAutoDefaultRom === 'boolean') {
        peer.isAutoDefaultRom = info.isAutoDefaultRom;
      }
      if (wsInstance) peer.ws = wsInstance;
      if (info.httpActive) peer.httpActive = true;
    }

    if (peer.ws?.readyState === 1 && peer.httpOutbox.length > 0) {
      const pending = peer.httpOutbox.splice(0, peer.httpOutbox.length);
      for (const m of pending) {
        try { peer.ws.send(JSON.stringify(m)); } catch {}
      }
    }

    const peers = getRoomPeersInfo(roomCode);
    if (isNewJoin || info.forceRoomJoined) {
      sendToPeer(peer, {
        type: 'room_joined',
        roomCode,
        clientId,
        playerIndex: peer.playerIndex,
        peers
      });
      broadcastToRoom(roomCode, clientId, {
        type: 'peer_joined',
        roomCode,
        peer: formatPeerInfo(peer),
        peers
      });
    }
    return peer;
  }

  function handlePeerMessage(peer, msg) {
    if (!peer || !msg || typeof msg.type !== 'string') return;
    peer.lastSeenAt = Date.now();

    if (msg.type === 'ping') {
      sendToPeer(peer, {
        type: 'pong', t: msg.t, via: msg.via, serverTime: Date.now()
      });
      return;
    }

    if (msg.type === 'autotest_report_ws' && msg.report) {
      const pIdx = msg.report.playerIndex || peer.playerIndex || 1;
      if (pIdx === 2) autotestSession.pc2 = msg.report;
      else autotestSession.pc1 = msg.report;
      saveAutotestReportToDisk();
      if (msg.report.isFinal && options.logAccess !== false) {
        console.log(
          `[AUTOTEST] Saved final report from PC ${pIdx}` +
            ' to logs/autotest_latest.txt'
        );
      }
      const syncMsg = {
        type: 'autotest_combined_text',
        combinedText: autotestSession.combinedText
      };
      if (msg.report.isFinal) {
        sendToPeer(peer, syncMsg);
        broadcastToRoom(peer.roomCode, peer.clientId, syncMsg);
      } else if (peer.playerIndex === 1) {
        sendToPeer(peer, syncMsg);
      }
      return;
    }

    if (msg.type === 'gameplay_telemetry_ws' &&
        (msg.telemetry || msg.payload)) {
      const telObj = msg.telemetry || msg.payload;
      const pIdx = telObj.playerIndex || peer.playerIndex || 1;
      if (pIdx === 2) gameplayTelemetrySession.pc2 = telObj;
      else gameplayTelemetrySession.pc1 = telObj;
      saveGameplayTelemetryToDisk();
      return;
    }

    if (msg.type === 'rom_info' ||
        msg.type === 'rom_sync' ||
        msg.type === 'rom_status') {
      if (msg.romCrc32 !== undefined) peer.romCrc32 = msg.romCrc32;
      if (msg.romName !== undefined) peer.romName = msg.romName;
      if (typeof msg.isAutoDefaultRom === 'boolean') {
        peer.isAutoDefaultRom = msg.isAutoDefaultRom;
      }
    }

    const shouldForward =
      FORWARD_TYPES.has(msg.type) ||
      msg.type.startsWith('rom_') ||
      msg.type.startsWith('match_') ||
      msg.type.startsWith('diag_') ||
      msg.type.startsWith('autotest_') ||
      msg.type.startsWith('telemetry_');

    if (shouldForward) {
      if (msg.type === 'netplay_input' && typeof msg.startFrame === 'number') {
        const firstIn = Array.isArray(msg.inputs) ? msg.inputs[0] : 0;
        const dedupKey =
          `${msg.sessionId || ''}:${msg.startFrame}:` +
          `${firstIn}:${msg.hashFrame || ''}`;
        if (peer._lastInputDedupKey === dedupKey) return;
        peer._lastInputDedupKey = dedupKey;
      }
      broadcastToRoom(peer.roomCode, peer.clientId, {
        ...msg,
        fromPlayer: peer.playerIndex,
        fromNick: peer.nick,
        serverRxTime: Date.now()
      });
    }
  }

  function removePeerSession(roomCode, clientId) {
    const roomMap = rooms.get(roomCode);
    if (!roomMap || !roomMap.has(clientId)) return;
    const removed = roomMap.get(clientId);
    roomMap.delete(clientId);
    if (roomMap.size === 0) {
      rooms.delete(roomCode);
    } else {
      broadcastToRoom(roomCode, clientId, {
        type: 'peer_left',
        playerIndex: removed.playerIndex,
        nick: removed.nick,
        peers: getRoomPeersInfo(roomCode)
      });
    }
  }

  function attachWebSocketServer(wss) {
    wss.on('connection', (ws, req) => {
      ws._socket?.setNoDelay?.(true);
      recordAccess(req, 'WS_CONNECTED /ws');
      ws.peerSession = null;

      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'ping' && !ws.peerSession) {
          ws.send(
            JSON.stringify({ type: 'pong', t: msg.t, serverTime: Date.now() })
          );
          return;
        }
        if (msg.type === 'bind_aux') {
          const roomCode = normCode(msg.roomCode);
          const clientId = String(msg.clientId || '');
          const peer = rooms.get(roomCode)?.get(clientId);
          if (peer) {
            peer.wsAux = ws;
            ws.peerSession = peer;
            ws.isAux = true;
            try {
              ws.send(
                JSON.stringify({ type: 'aux_bound', roomCode, clientId })
              );
            } catch {}
          }
          return;
        }
        if (msg.type === 'join_room') {
          const roomCode = normCode(msg.roomCode);
          const randSuffix = Math.random().toString(36).slice(2, 7);
          const clientId = String(
            msg.clientId || `ws_${Date.now()}_${randSuffix}`
          );
          if (ws.peerSession && ws.peerSession.roomCode !== roomCode) {
            removePeerSession(ws.peerSession.roomCode, ws.peerSession.clientId);
          }
          const peer = joinOrUpdatePeerSession(
            roomCode,
            clientId,
            {
              nick: msg.nick,
              romCrc32: msg.romCrc32,
              romName: msg.romName,
              isAutoDefaultRom: msg.isAutoDefaultRom,
              forceRoomJoined: true
            },
            ws
          );
          ws.peerSession = peer;
          recordAccess(
            req,
            `WS_JOIN room=${roomCode} P${peer.playerIndex} (${peer.nick})`
          );
          return;
        }
        if (ws.peerSession) handlePeerMessage(ws.peerSession, msg);
      });

      ws.on('close', () => {
        const peer = ws.peerSession;
        if (ws.isAux) {
          if (peer && peer.wsAux === ws) peer.wsAux = null;
          return;
        }
        if (peer && peer.ws === ws) {
          peer.ws = null;
          if (peer.wsAux) {
            try { peer.wsAux.close(); } catch {}
            peer.wsAux = null;
          }
          removePeerSession(peer.roomCode, peer.clientId);
        }
      });
    });
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [rc, roomMap] of rooms.entries()) {
      for (const [cid, peer] of roomMap.entries()) {
        if (peer.ws?.readyState !== 1 && now - peer.lastSeenAt > 12000) {
          removePeerSession(rc, cid);
        }
      }
    }
  }, 3000);
  cleanupTimer.unref?.();

  return {
    rooms, getOrCreateRoom, getRoomPeersInfo, joinOrUpdatePeerSession,
    handlePeerMessage, removePeerSession, attachWebSocketServer,
    stopCleanup: () => clearInterval(cleanupTimer)
  };
}
