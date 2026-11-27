// Room Session Manager, Dual-WebSocket Striping & Message Relay
import {
  createWireRttProber, relayRawNetplayInput, relayBinaryNetplayInput
} from './wire_rtt_prober.mjs';
import {
  handleAutotestReportWs, handleGameplayTelemetryWs
} from './telemetry_relay_handlers.mjs';
import { isLocalHostRequest } from './tunnel_candidates.mjs';

const FORWARD_TYPES = new Set([
  'netplay_input', 'state_sync', 'sync_ack', 'resync_request', 'console_reset',
  'rom_info', 'rom_status', 'rom_request', 'rom_sync', 'webrtc_signal',
  'peer_ping', 'peer_pong', 'speed_ctrl', 'state', 'event', 'warp_request',
  'warp_snapshot'
]);

const normCode = (raw) =>
  String(raw || 'NOVA').trim().toUpperCase().slice(0, 12);

function seenInputKey(peer, key) {
  let s = peer._rxInputDedupSet;
  if (!s) s = peer._rxInputDedupSet = new Set();
  if (s.has(key)) return true;
  s.add(key);
  if (s.size > 128) s.delete(s.keys().next().value);
  return false;
}

export function createRoomManager(trackers, options = {}) {
  const rooms = new Map();
  const { recordAccess } = trackers;

  function getOrCreateRoom(roomCode) {
    if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
    return rooms.get(roomCode);
  }

  function formatPeerInfo(peer) {
    return {
      clientId: peer.clientId, playerIndex: peer.playerIndex, nick: peer.nick,
      romCrc32: peer.romCrc32, romName: peer.romName,
      isAutoDefaultRom: Boolean(peer.isAutoDefaultRom),
      routeOptimized: Boolean(peer.routeOptimized),
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
    const socks = payloadObj.type === 'netplay_input'
      ? [peer.ws, peer.wsAux] : [peer.ws];
    for (const s of socks) {
      if (s?.readyState !== 1) continue;
      try { s.send(raw); peer.lastTxAt = Date.now(); sentViaWs = true; }
      catch {}
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

  const wireProber = createWireRttProber(rooms, options.wirePingIntervalMs);

  function joinOrUpdatePeerSession(
    roomCodeRaw, clientIdRaw, info = {}, wsInstance = null
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
      const used = new Set(Array.from(roomMap.values(), (p) => p.playerIndex));
      const preferP2 = Boolean(wsInstance) && !wsInstance._isLocalHost &&
        options.hasActiveTunnel?.() && roomMap.size === 0;
      const pIdx = preferP2 ? 2 : (used.has(1) ? 2 : 1);
      peer = {
        clientId, roomCode, playerIndex: pIdx,
        nick: String(info.nick || 'Player').slice(0, 20),
        romCrc32: info.romCrc32 || null, romName: info.romName || null,
        isAutoDefaultRom: typeof info.isAutoDefaultRom === 'boolean'
          ? info.isAutoDefaultRom : true,
        routeOptimized: Boolean(info.routeOptimized),
        ws: wsInstance || null, httpActive: Boolean(info.httpActive),
        httpOutbox: [], nextSeq: 1, lastSeenAt: Date.now()
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
      if (typeof info.routeOptimized === 'boolean') {
        peer.routeOptimized = info.routeOptimized;
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
        type: 'room_joined', roomCode, clientId,
        playerIndex: peer.playerIndex, peers
      });
      broadcastToRoom(roomCode, clientId, {
        type: 'peer_joined', roomCode, peer: formatPeerInfo(peer), peers
      });
      if (roomMap.size >= 2) {
        setTimeout(() => wireProber.probeRoomWires(roomCode), 25);
      }
    }
    return peer;
  }

  function handlePeerMessage(peer, msg, rawStr = null) {
    if (!peer || !msg || typeof msg.type !== 'string') return;
    peer.lastSeenAt = Date.now();

    if (msg.type === 'ping') {
      sendToPeer(peer, {
        type: 'pong', t: msg.t, via: msg.via, serverTime: Date.now()
      });
      return;
    }

    if (msg.type === 'autotest_report_ws' && msg.report) {
      return handleAutotestReportWs(
        peer, msg, trackers, options, sendToPeer, broadcastToRoom
      );
    }

    if (msg.type === 'gameplay_telemetry_ws' &&
        (msg.telemetry || msg.payload)) {
      return handleGameplayTelemetryWs(peer, msg, trackers);
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
      msg.type.startsWith('route_') ||
      msg.type.startsWith('diag_') ||
      msg.type.startsWith('autotest_') ||
      msg.type.startsWith('telemetry_');

    if (shouldForward) {
      if (msg.type === 'netplay_input' && typeof msg.startFrame === 'number') {
        return relayRawNetplayInput(rooms, peer, msg, rawStr, seenInputKey);
      }
      broadcastToRoom(peer.roomCode, peer.clientId, {
        ...msg, fromPlayer: peer.playerIndex,
        fromNick: peer.nick, serverRxTime: Date.now()
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
      ws._isLocalHost = isLocalHostRequest(req);
      recordAccess(req, 'WS_CONNECTED /ws');
      ws.peerSession = null;
      wireProber.attachPongHandler(ws);

      ws.on('message', (data, isBinary) => {
        if (isBinary && ws.peerSession) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          ws.peerSession.lastSeenAt = Date.now();
          if (relayBinaryNetplayInput(
            rooms, ws.peerSession, buf, seenInputKey
          )) return;
          const rm = rooms.get(ws.peerSession.roomCode);
          if (rm) {
            for (const dst of rm.values()) {
              if (dst.clientId !== ws.peerSession.clientId &&
                  dst.ws?.readyState === 1) {
                try { dst.ws.send(buf); } catch {}
              }
            }
          }
          return;
        }
        const rawStr = data.toString();
        let msg;
        try { msg = JSON.parse(rawStr); } catch { return; }
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
            wireProber.pingSock(ws);
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
          const reqAuth = options.getRequiredRoomAuth?.();
          if (
            !ws._isLocalHost && reqAuth?.authToken &&
            msg.roomAuth !== reqAuth.authToken
          ) {
            try {
              ws.send(JSON.stringify({
                type: 'auth_required', roomCode,
                reason: 'Room password required or incorrect'
              }));
            } catch {}
            return;
          }
          const randSuffix = Math.random().toString(36).slice(2, 7);
          const clientId = String(
            msg.clientId || `ws_${Date.now()}_${randSuffix}`
          );
          if (ws.peerSession && ws.peerSession.roomCode !== roomCode) {
            removePeerSession(ws.peerSession.roomCode, ws.peerSession.clientId);
          }
          const peer = joinOrUpdatePeerSession(
            roomCode, clientId, {
              nick: msg.nick, romCrc32: msg.romCrc32, romName: msg.romName,
              isAutoDefaultRom: msg.isAutoDefaultRom,
              routeOptimized: Boolean(msg.routeOptimized),
              forceRoomJoined: true
            }, ws
          );
          ws.peerSession = peer;
          recordAccess(
            req, `WS_JOIN room=${roomCode} P${peer.playerIndex} (${peer.nick})`
          );
          return;
        }
        if (ws.peerSession) handlePeerMessage(ws.peerSession, msg, rawStr);
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
    stopCleanup: () => { clearInterval(cleanupTimer); wireProber.stop(); }
  };
}
