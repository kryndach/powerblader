// RFC 6455 C++ WebSocket Ping Wire-RTT Prober & Raw Netplay Input Fast-Path
import {
  BIN_MAGIC_INPUT, extractBinaryInputDedupKey, decodeNetplayPacketBinary,
  isBinaryNetplayPacket, isBinaryRomChunk, decodeBinaryRomChunk,
  hashSessionId32
} from '../src/binary_net_codec.mjs';

export function createWireRttProber(rooms, intervalMs = 1500) {
  function pingSock(s) {
    if (!s || s.readyState !== 1) return;
    s._pingAt = performance.now();
    try { s.ping(); } catch {}
  }

  function probeRoomWires(roomCode) {
    const roomMap = rooms.get(roomCode);
    if (!roomMap) return;
    for (const p of roomMap.values()) {
      pingSock(p.ws);
      pingSock(p.wsAux);
    }
  }

  function broadcastWireRtt(roomCode) {
    const roomMap = rooms.get(roomCode);
    if (!roomMap || roomMap.size < 2) return;
    const legs = [];
    for (const p of roomMap.values()) {
      const a = p.ws?.readyState === 1 ? p.ws._legRtt : undefined;
      const b = p.wsAux?.readyState === 1 ? p.wsAux._legRtt : undefined;
      const best = a !== undefined && b !== undefined
        ? Math.min(a, b) : (a ?? b);
      if (typeof best === 'number') legs.push(best);
    }
    if (legs.length < 2) return;
    const now = performance.now();
    if (now - (roomMap._lastWireAt || 0) < 50) return;
    roomMap._lastWireAt = now;
    const raw = JSON.stringify({
      type: 'wire_rtt', rttMs: Math.max(1, legs[0] + legs[1])
    });
    for (const p of roomMap.values()) {
      if (p.ws?.readyState === 1) {
        try { p.ws.send(raw); } catch {}
      }
    }
  }

  function attachPongHandler(ws) {
    ws.on('pong', () => {
      if (!(ws._pingAt > 0)) return;
      ws._legRtt = Math.max(0, Math.round(performance.now() - ws._pingAt));
      ws._pingAt = 0;
      if (ws.peerSession) broadcastWireRtt(ws.peerSession.roomCode);
    });
  }

  const timer = setInterval(() => {
    for (const rc of rooms.keys()) probeRoomWires(rc);
  }, intervalMs);
  timer.unref?.();

  return {
    pingSock, probeRoomWires, attachPongHandler,
    stop: () => clearInterval(timer)
  };
}

export function relayRawNetplayInput(rooms, peer, msg, rawStr, seenInputKey) {
  const firstIn = Array.isArray(msg.inputs) ? msg.inputs[0] : 0;
  const dedupKey = `${msg.sessionId || ''}:${msg.startFrame}:` +
    `${firstIn}:${msg.hashFrame || ''}`;
  if (seenInputKey(peer, dedupKey)) return;
  const roomMap = rooms.get(peer.roomCode);
  if (!roomMap) return;
  const fastRaw = rawStr || JSON.stringify(msg);
  for (const dst of roomMap.values()) {
    if (dst.clientId === peer.clientId) continue;
    let sent = false;
    for (const s of [dst.ws, dst.wsAux]) {
      if (s?.readyState !== 1) continue;
      try { s.send(fastRaw); dst.lastTxAt = Date.now(); sent = true; } catch {}
    }
    if (!sent) {
      dst.httpOutbox.push({ ...msg, _seq: dst.nextSeq++ });
      if (dst.httpOutbox.length > 400) dst.httpOutbox.shift();
    }
  }
}

export function recordRoomSessionId(rooms, roomCode, sid) {
  if (!sid || typeof sid !== 'string') return;
  const roomMap = rooms.get(roomCode);
  if (!roomMap) return;
  let map = roomMap._sidByHash;
  if (!map) map = roomMap._sidByHash = new Map();
  map.set(hashSessionId32(sid), sid);
  if (map.size > 32) map.delete(map.keys().next().value);
}

function pushHttpOutbox(dst, msg) {
  dst.httpOutbox.push({ ...msg, _seq: dst.nextSeq++ });
  if (dst.httpOutbox.length > 400) dst.httpOutbox.shift();
}

function decodeNonInputBinaryForHttp(rawBuf, sidMap) {
  if (isBinaryNetplayPacket(rawBuf)) {
    return decodeNetplayPacketBinary(rawBuf);
  }
  if (isBinaryRomChunk(rawBuf)) {
    const dv = new DataView(
      rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength
    );
    const expectedSid = sidMap?.get(dv.getUint32(1, true)) || null;
    const dec = decodeBinaryRomChunk(rawBuf, expectedSid);
    if (!dec) return null;
    const dataB64 = Buffer.from(
      dec.data.buffer, dec.data.byteOffset, dec.data.byteLength
    ).toString('base64');
    return {
      type: dec.type, sessionId: dec.sessionId, index: dec.index, dataB64
    };
  }
  return null;
}

export function relayBinaryNetplayInput(rooms, peer, rawBuf, seenInputKey) {
  const meta = extractBinaryInputDedupKey(rawBuf);
  if (!meta) {
    return Boolean(rawBuf?.length > 0 && rawBuf[0] === BIN_MAGIC_INPUT);
  }
  if (seenInputKey(peer, meta.dedupKey)) return true;
  const roomMap = rooms.get(peer.roomCode);
  if (!roomMap) return true;
  for (const dst of roomMap.values()) {
    if (dst.clientId === peer.clientId) continue;
    let sent = false;
    const sendAux = !dst.ws?._isLocalHost &&
      ((meta.startFrame & 1) === 0 || meta.hasHash);
    const socks = sendAux ? [dst.ws, dst.wsAux] : [dst.ws];
    for (const s of socks) {
      if (s?.readyState !== 1) continue;
      try { s.send(rawBuf); dst.lastTxAt = Date.now(); sent = true; } catch {}
    }
    if (!sent) {
      const expectedSid = roomMap._sidByHash?.get(meta.sidHash) || null;
      const dec = decodeNetplayPacketBinary(rawBuf, expectedSid);
      if (dec) pushHttpOutbox(dst, dec);
    }
  }
  return true;
}

export function relayBinaryFrame(rooms, peer, rawBuf, seenInputKey) {
  try {
    if (!rawBuf || rawBuf.length === 0) return;
    if (relayBinaryNetplayInput(rooms, peer, rawBuf, seenInputKey)) return;
    const roomMap = rooms.get(peer.roomCode);
    if (!roomMap) return;
    let httpDecoded = undefined;
    for (const dst of roomMap.values()) {
      if (dst.clientId === peer.clientId) continue;
      if (dst.ws?.readyState === 1) {
        try { dst.ws.send(rawBuf); dst.lastTxAt = Date.now(); continue; }
        catch {}
      }
      if (httpDecoded === undefined) {
        httpDecoded = decodeNonInputBinaryForHttp(rawBuf, roomMap._sidByHash);
      }
      if (httpDecoded) pushHttpOutbox(dst, httpDecoded);
    }
  } catch {}
}
