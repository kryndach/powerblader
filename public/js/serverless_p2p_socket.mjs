// Serverless Browser-to-Browser WebRTC Virtual WebSocket via Encrypted Nostr
import {
  deriveUniversalKeys, decryptJsonAesGcm, signUniversalNostrEvent
} from '../../src/nostr_browser_crypto.mjs';
import { deriveRoomSecret, normalizeRoomCode } from '../../src/room_auth.mjs';
import { buildGameplayIceServers } from './ice_config.mjs';

export const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social'
];

function waitForIceComplete(rtc, maxMs = 1500) {
  if (rtc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      rtc.removeEventListener('icegatheringstatechange', chk);
      resolve();
    }, maxMs);
    function chk() {
      if (rtc.iceGatheringState === 'complete') {
        clearTimeout(t);
        rtc.removeEventListener('icegatheringstatechange', chk);
        resolve();
      }
    }
    rtc.addEventListener('icegatheringstatechange', chk);
  });
}

export async function publishEncryptedNostr(relays, keys, payloadObj) {
  const ev = await signUniversalNostrEvent(payloadObj, keys);
  const sendOne = (url) => new Promise((resolve) => {
    let done = false, ws = null;
    const end = (ok) => {
      if (done) return;
      done = true; clearTimeout(tmr);
      try { ws?.close(); } catch {}
      resolve(ok);
    };
    const tmr = setTimeout(() => end(false), 4000);
    try {
      ws = new WebSocket(url);
      ws.onopen = () => ws.send(JSON.stringify(['EVENT', ev]));
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m[0] === 'OK' && m[1] === ev.id) end(Boolean(m[2]));
        } catch {}
      };
      ws.onerror = () => end(false);
    } catch { end(false); }
  });
  const res = await Promise.all((relays || DEFAULT_NOSTR_RELAYS).map(sendOne));
  return res.filter(Boolean).length;
}

export function subscribeEncryptedNostr(relays, keys, onPayload) {
  const socks = [];
  let closed = false;
  const seenIds = new Set();
  const filter = { kinds: [30078], '#d': [keys.dTag], limit: 4 };
  for (const url of relays || DEFAULT_NOSTR_RELAYS) {
    try {
      const ws = new WebSocket(url);
      socks.push(ws);
      ws.onopen = () => {
        if (!closed) {
          ws.send(JSON.stringify(['REQ', `s_${Date.now()}`, filter]));
        }
      };
      ws.onmessage = async (e) => {
        if (closed) return;
        try {
          const m = JSON.parse(e.data);
          if (m[0] !== 'EVENT' || !m[2]?.content || seenIds.has(m[2].id)) {
            return;
          }
          seenIds.add(m[2].id);
          const data = await decryptJsonAesGcm(m[2].content, keys.aesRaw);
          onPayload(data, m[2]);
        } catch {}
      };
    } catch {}
  }
  return () => {
    closed = true;
    for (const s of socks) { try { s.close(); } catch {} }
  };
}

export function createServerlessP2pSocket({
  role = 'host', roomCode = 'NOVA', password = '', nick = 'Player',
  relays = DEFAULT_NOSTR_RELAYS, iceServers = null,
  existingOffer = null, onStatus = null
}) {
  const resolvedIce = iceServers || buildGameplayIceServers();
  const room = normalizeRoomCode(roomCode);
  const myIndex = role === 'host' ? 1 : 2;
  const peerIndex = myIndex === 1 ? 2 : 1;
  const clientId = `p2p_${myIndex}_${Math.random().toString(36).slice(2, 7)}`;
  const sid = existingOffer?.sid ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  let rtc = null, ctrlDc = null, inputDc = null, discTimer = null;
  let stopSub = null, closed = false, peerInfo = null;
  let localJoinInfo = { nick, romCrc32: null, romName: null };

  const sock = {
    isServerlessP2p: true,
    readyState: 0,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    get bufferedAmount() { return ctrlDc?.bufferedAmount || 0; },
    send(raw) {
      if (closed || !ctrlDc || ctrlDc.readyState !== 'open') return;
      if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
        const u8 = raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        const fast = u8[0] === 0x4e || u8[0] === 0x50 || u8[0] === 0x51;
        const dc = fast && inputDc?.readyState === 'open' ? inputDc : ctrlDc;
        try { dc.send(raw); } catch {}
        return;
      }
      if (typeof raw !== 'string') return;
      if (raw.startsWith('{"type":"join_room"')) {
        let msg = null;
        try { msg = JSON.parse(raw); } catch { return; }
        localJoinInfo = {
          nick: msg.nick || nick, romCrc32: msg.romCrc32 || null,
          romName: msg.romName || null,
          isAutoDefaultRom: Boolean(msg.isAutoDefaultRom)
        };
        ctrlDc.send(JSON.stringify({
          type: 'p2p_hello', clientId, playerIndex: myIndex, ...localJoinInfo
        }));
        const peers = [{ clientId, playerIndex: myIndex, ...localJoinInfo }];
        if (peerInfo) peers.push(peerInfo);
        emitLocal({
          type: 'room_joined', roomCode: room, clientId,
          playerIndex: myIndex, peers
        });
        return;
      }
      const useUnordered = raw.startsWith('{"type":"netplay_input"') ||
        raw.startsWith('{"type":"peer_ping"') ||
        raw.startsWith('{"type":"peer_pong"');
      if (useUnordered && inputDc?.readyState === 'open') {
        try { inputDc.send(raw); return; } catch {}
      }
      try { ctrlDc.send(raw); } catch {}
    },
    async getIceSummary() {
      if (!rtc?.getStats) return null;
      try {
        const stats = await rtc.getStats();
        let activePair = null;
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' &&
              (r.selected || r.state === 'succeeded')) {
            if (!activePair || r.selected) activePair = r;
          }
        });
        if (!activePair) return null;
        const loc = stats.get(activePair.localCandidateId);
        const rem = stats.get(activePair.remoteCandidateId);
        return {
          protocol: loc?.protocol || 'udp',
          localType: loc?.candidateType || 'unknown',
          remoteType: rem?.candidateType || 'unknown',
          rttMs: activePair.currentRoundTripTime
            ? Math.round(activePair.currentRoundTripTime * 1000) : null
        };
      } catch { return null; }
    },
    close() {
      if (closed) return;
      closed = true;
      if (discTimer) { clearTimeout(discTimer); discTimer = null; }
      sock.readyState = 3;
      try { stopSub?.(); } catch {}
      try { ctrlDc?.close(); } catch {}
      try { inputDc?.close(); } catch {}
      try { rtc?.close(); } catch {}
      sock.onclose?.();
    }
  };

  function emitLocal(obj) {
    if (!closed) sock.onmessage?.({ data: JSON.stringify(obj) });
  }

  function handlePeerChannelData(rawData) {
    if (closed) return;
    if (typeof rawData !== 'string') {
      sock.onmessage?.({ data: rawData });
      return;
    }
    if (rawData.startsWith('{"type":"p2p_hello"')) {
      let msg = null;
      try { msg = JSON.parse(rawData); } catch { return; }
      peerInfo = {
        clientId: msg.clientId || 'p2p_peer', playerIndex: peerIndex,
        nick: msg.nick || `Player ${peerIndex}`,
        romCrc32: msg.romCrc32 || null, romName: msg.romName || null,
        isAutoDefaultRom: Boolean(msg.isAutoDefaultRom)
      };
      emitLocal({ type: 'peer_joined', peer: peerInfo });
      return;
    }
    sock.onmessage?.({ data: rawData });
  }

  function attachCtrlChannel(dc) {
    ctrlDc = dc;
    try { dc.binaryType = 'arraybuffer'; } catch {}
    dc.onopen = () => {
      if (closed) return;
      try { stopSub?.(); stopSub = null; } catch {}
      sock.readyState = 1;
      onStatus?.('WebRTC P2P Direct Link OPEN!', 'connected', {});
      sock.onopen?.();
    };
    dc.onmessage = (ev) => handlePeerChannelData(ev.data);
    dc.onclose = () => sock.close();
  }

  function attachInputChannel(dc) {
    inputDc = dc;
    try { dc.binaryType = 'arraybuffer'; } catch {}
    dc.onmessage = (ev) => handlePeerChannelData(ev.data);
  }

  (async () => {
    try {
      const secret = deriveRoomSecret(room, password);
      if (!secret) throw new Error('Password required for Serverless P2P');
      const offerKeys = await deriveUniversalKeys(secret, '_p2p_offer');
      const ansKeys = await deriveUniversalKeys(secret, '_p2p_answer');
      rtc = new RTCPeerConnection({ iceServers: resolvedIce });
      rtc.onconnectionstatechange = () => {
        const st = rtc?.connectionState;
        if (st === 'connected') {
          if (discTimer) { clearTimeout(discTimer); discTimer = null; }
        } else if (st === 'disconnected') {
          if (!discTimer) {
            discTimer = setTimeout(() => {
              discTimer = null;
              if (rtc?.connectionState !== 'connected') sock.close();
            }, 4000);
          }
        } else if (st === 'failed' || st === 'closed') {
          sock.close();
        }
      };
      if (role === 'host') {
        attachCtrlChannel(rtc.createDataChannel('ctrl', { ordered: true }));
        attachInputChannel(rtc.createDataChannel('input', {
          ordered: false, maxRetransmits: 0
        }));
        const offer = await rtc.createOffer();
        await rtc.setLocalDescription(offer);
        onStatus?.('Gathering ICE candidates for P2P Host...', 'gathering', {});
        await waitForIceComplete(rtc, 1500);
        if (closed) return;
        let answered = false;
        stopSub = subscribeEncryptedNostr(relays, ansKeys, async (ans) => {
          if (closed || answered || ans?.sid !== sid || !ans.sdp) return;
          answered = true;
          onStatus?.(
            'Partner answered! Opening direct P2P channel...', 'answering', {}
          );
          try { await rtc.setRemoteDescription(ans.sdp); } catch {}
        });
        const sdpOut = {
          type: rtc.localDescription.type, sdp: rtc.localDescription.sdp
        };
        const okCnt = await publishEncryptedNostr(relays, offerKeys, {
          type: 'p2p_offer', sid, room, nick, sdp: sdpOut, ts: Date.now()
        });
        onStatus?.(
          okCnt > 0
            ? `P2P Host online (${okCnt} relays) — waiting for partner...`
            : 'Failed to reach Nostr relays',
          okCnt > 0 ? 'hosting' : 'error', { relayCount: okCnt, room }
        );
      } else {
        rtc.ondatachannel = (ev) => {
          if (ev.channel.label === 'input') attachInputChannel(ev.channel);
          else attachCtrlChannel(ev.channel);
        };
        const acceptOffer = async (off) => {
          if (closed || !off?.sdp) return;
          onStatus?.(
            'Found P2P Host! Sending encrypted answer...', 'answering', {}
          );
          await rtc.setRemoteDescription(off.sdp);
          const ans = await rtc.createAnswer();
          await rtc.setLocalDescription(ans);
          await waitForIceComplete(rtc, 1500);
          if (closed) return;
          const ansOut = {
            type: rtc.localDescription.type, sdp: rtc.localDescription.sdp
          };
          await publishEncryptedNostr(relays, ansKeys, {
            type: 'p2p_answer', sid: off.sid, room, nick,
            sdp: ansOut, ts: Date.now()
          });
        };
        if (existingOffer?.sdp) {
          await acceptOffer(existingOffer);
        } else {
          let handled = false;
          stopSub = subscribeEncryptedNostr(relays, offerKeys, (off) => {
            if (handled || !off?.sdp) return;
            if (Date.now() - (off.ts || 0) > 300000) return;
            handled = true;
            acceptOffer(off).catch(() => sock.close());
          });
        }
      }
    } catch (e) {
      onStatus?.(`P2P Error: ${e.message}`, 'error', {});
      sock.onerror?.(e);
      sock.close();
    }
  })();

  return sock;
}
