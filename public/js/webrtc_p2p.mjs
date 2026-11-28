// WebRTC P2P DataChannel & Dual-WebSocket (ws + wsAux) Transport Manager
import { buildWsUrl } from './server_endpoint.mjs';
import {
  buildGameplayIceServers, waitForRtcGathering, inspectSelectedIcePair
} from './ice_config.mjs';
import { createMultiPathRacer } from './multipath_racer.mjs';
import {
  encodeNetplayPacketBinary, decodeNetplayPacketBinary, isBinaryNetplayPacket
} from '../../src/binary_net_codec.mjs';

export function createNetTransport(
  state, ui, onIncomingMessage, options = {}
) {
  const racer = createMultiPathRacer(
    options.now ? { now: options.now } : undefined
  );
  let rtcPathKind = 'direct_p2p';
  let lastSyncedP2p = null, lastSyncedWss = null, hasLiveRttFeed = false;
  const origReset = racer.reset;
  racer.reset = () => {
    lastSyncedP2p = lastSyncedWss = null;
    hasLiveRttFeed = false;
    origReset();
  };
  state.multipathRacer = racer;
  state.rtcPathKind = rtcPathKind;

  const p2pLabel = () =>
    (rtcPathKind === 'turn_443' ? 'TURN/443' : 'Direct P2P');

  function syncWinnerToState() {
    const win = racer.selectActivePath();
    if (!win) return null;
    const next = win.id === 'p2p';
    if (state._usingP2pAuto !== next) {
      state._usingP2pAuto = next;
      ui.updateStatusStrip?.();
    }
    return next;
  }

  function recordPathRtt(id, rttMs) {
    if (!(rttMs > 0)) return;
    hasLiveRttFeed = true;
    if (id === 'p2p') {
      lastSyncedP2p = rttMs;
      racer.recordSample('p2p', {
        kind: rtcPathKind, label: p2pLabel(), rttMs
      });
    } else {
      lastSyncedWss = rttMs;
      racer.recordSample('wss', { kind: 'wss', label: 'WSS Relay', rttMs });
    }
    syncWinnerToState();
  }
  state.recordPathRtt = recordPathRtt;

  function closeWebRtc() {
    racer.removePath('p2p');
    lastSyncedP2p = null;
    rtcPathKind = state.rtcPathKind = 'direct_p2p';
    state.p2pRttMs = 0;
    state._usingP2pAuto = undefined;
    const prevCh = state.rtcChannel, prevPeer = state.rtcPeer;
    state.rtcChannel = state.rtcPeer = null;
    if (prevCh) { try { prevCh.close(); } catch {} }
    if (prevPeer) { try { prevPeer.close(); } catch {} }
    ui.dbgRtcState.textContent = 'Closed';
    ui.updateStatusStrip();
  }

  function decodeWirePayload(data) {
    if (isBinaryNetplayPacket(data)) {
      return decodeNetplayPacketBinary(data, state.engine?.sessionId);
    }
    return typeof data === 'string' ? JSON.parse(data) : null;
  }

  function shouldAutoUseP2p() {
    if (!hasLiveRttFeed) {
      const p2p = state.p2pRttMs, wss = state.wssRttMs;
      if (p2p > 0 && p2p !== lastSyncedP2p) {
        lastSyncedP2p = p2p;
        racer.setPathMetrics('p2p', {
          kind: rtcPathKind, label: p2pLabel(), rttMs: p2p
        });
      }
      if (wss > 0 && wss !== lastSyncedWss) {
        lastSyncedWss = wss;
        racer.setPathMetrics('wss', {
          kind: 'wss', label: 'WSS Relay', rttMs: wss
        });
      }
    }
    const chosen = syncWinnerToState();
    if (chosen !== null) return chosen;
    if (state._usingP2pAuto === undefined) state._usingP2pAuto = true;
    return state._usingP2pAuto;
  }

  async function reportRealIceType(rtc) {
    try {
      const info = await inspectSelectedIcePair(rtc);
      if (!info || state.rtcPeer !== rtc) return;
      rtcPathKind = state.rtcPathKind = info.pathKind;
      racer.updatePathMeta?.('p2p', { kind: rtcPathKind, label: p2pLabel() });
      syncWinnerToState();
      ui.dbgRtcState.textContent = `OPEN (${info.proto} ${info.label})`;
      ui.updateStatusStrip();
    } catch {}
  }

  function setupRtcDataChannel(channel, rtc) {
    state.rtcChannel = channel;
    try { channel.binaryType = 'arraybuffer'; } catch {}
    ui.dbgRtcState.textContent = 'Connecting...';
    channel.onopen = () => {
      if (state.rtcChannel !== channel) return;
      ui.dbgRtcState.textContent = 'OPEN (Probing...)';
      ui.logDebug('WebRTC P2P DataChannel OPEN! Probing RTT vs WSS.');
      try {
        channel.send(encodeNetplayPacketBinary({
          type: 'peer_ping', t: Date.now()
        }));
      } catch {}
      setTimeout(() => reportRealIceType(rtc || state.rtcPeer), 400);
      ui.updateStatusStrip();
    };
    channel.onclose = () => {
      if (state.rtcChannel !== channel) return;
      state.rtcChannel = null;
      state.p2pRttMs = 0;
      state._usingP2pAuto = false;
      lastSyncedP2p = null;
      racer.removePath('p2p');
      ui.dbgRtcState.textContent = 'Closed (WSS Fallback)';
      ui.logDebug('WebRTC DataChannel closed; falling back to WSS Relay.');
      ui.updateStatusStrip();
    };
    channel.onerror = () => {
      if (state.rtcChannel !== channel) return;
      ui.dbgRtcState.textContent = 'Blocked (Using WSS)';
      ui.updateStatusStrip();
    };
    channel.onmessage = (ev) => {
      if (state.rtcChannel !== channel) return;
      try {
        const msg = decodeWirePayload(ev.data);
        if (msg) onIncomingMessage(msg, 'p2p');
      } catch {}
    };
  }

  async function flushPendingIce(rtc) {
    const q = rtc?._pendingIce;
    if (!q?.length || !rtc.remoteDescription || state.rtcPeer !== rtc) return;
    rtc._pendingIce = [];
    for (const cand of q) {
      if (state.rtcPeer !== rtc) return;
      try { await rtc.addIceCandidate(new RTCIceCandidate(cand)); } catch {}
    }
  }

  async function startWebRtcSession(isInitiator) {
    if (state.ws?.isServerlessP2p) return;
    closeWebRtc();
    if (typeof RTCPeerConnection === 'undefined') {
      ui.dbgRtcState.textContent = 'Unsupported';
      return;
    }
    try {
      const rtc = new RTCPeerConnection({
        iceServers: buildGameplayIceServers()
      });
      rtc._sdpSent = false;
      rtc._pendingIce = [];
      state.rtcPeer = rtc;

      rtc.onicecandidate = (ev) => {
        if (
          state.rtcPeer === rtc && rtc._sdpSent &&
          ev.candidate?.candidate && state.ws?.readyState === 1
        ) {
          state.ws.send(JSON.stringify({
            type: 'webrtc_signal', signal: { candidate: ev.candidate }
          }));
        }
      };

      rtc.onconnectionstatechange = () => {
        if (state.rtcPeer !== rtc) return;
        const st = rtc.connectionState;
        if (st === 'failed') {
          racer.removePath('p2p');
          lastSyncedP2p = null;
          state.p2pRttMs = 0;
          state._usingP2pAuto = false;
        }
        if (st === 'failed' || st === 'disconnected') {
          ui.dbgRtcState.textContent = `Fallback (${st})`;
          ui.updateStatusStrip();
        }
      };

      if (isInitiator) {
        const dc = rtc.createDataChannel('nes_netplay', {
          ordered: false, maxRetransmits: 0
        });
        setupRtcDataChannel(dc, rtc);
        const offer = await rtc.createOffer();
        if (state.rtcPeer !== rtc) return;
        await rtc.setLocalDescription(offer);
        if (state.rtcPeer !== rtc) return;
        await waitForRtcGathering(rtc, 1200);
        if (state.rtcPeer !== rtc) return;
        rtc._sdpSent = true;
        if (state.ws?.readyState === 1 && rtc.localDescription) {
          state.ws.send(JSON.stringify({
            type: 'webrtc_signal', signal: { sdp: rtc.localDescription }
          }));
        }
      } else {
        rtc.ondatachannel = (ev) => {
          if (state.rtcPeer === rtc) setupRtcDataChannel(ev.channel, rtc);
        };
      }
    } catch (e) {
      ui.dbgRtcState.textContent = 'Error (Using WSS)';
      ui.logDebug(`WebRTC init error: ${e.message}`);
    }
  }

  async function handleWebRtcSignal(signal) {
    if (!signal) return;
    if (!state.rtcPeer) await startWebRtcSession(false);
    const rtc = state.rtcPeer;
    if (!rtc) return;
    try {
      if (signal.sdp) {
        await rtc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (state.rtcPeer !== rtc) return;
        await flushPendingIce(rtc);
        if (state.rtcPeer !== rtc) return;
        if (signal.sdp.type === 'offer') {
          const answer = await rtc.createAnswer();
          if (state.rtcPeer !== rtc) return;
          await rtc.setLocalDescription(answer);
          if (state.rtcPeer !== rtc) return;
          await waitForRtcGathering(rtc, 1200);
          if (state.rtcPeer !== rtc) return;
          rtc._sdpSent = true;
          if (state.ws?.readyState === 1 && rtc.localDescription) {
            state.ws.send(JSON.stringify({
              type: 'webrtc_signal', signal: { sdp: rtc.localDescription }
            }));
          }
        }
      } else if (signal.candidate) {
        if (!rtc.remoteDescription) {
          (rtc._pendingIce ||= []).push(signal.candidate);
        } else {
          await rtc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      }
    } catch (e) {
      ui.logDebug(`WebRTC signal warning: ${e.message}`);
    }
  }

  function connectAuxWebSocket(code, cid) {
    if (state.ws?.isServerlessP2p) return;
    if (state.wsAux) {
      try { state.wsAux.close(); } catch {}
      state.wsAux = null;
    }
    if (!code || !cid) return;
    const h = globalThis.window?.location?.hostname || '';
    if (!state.apiBaseUrl && (h === 'localhost' || h === '127.0.0.1')) return;
    try {
      const aux = new WebSocket(buildWsUrl(state, '/ws?aux=1'));
      aux.binaryType = 'arraybuffer';
      state.wsAux = aux;
      aux.onopen = () => {
        if (state.wsAux?.readyState === 1) {
          state.wsAux.send(
            JSON.stringify({ type: 'bind_aux', roomCode: code, clientId: cid })
          );
        }
      };
      aux.onmessage = (ev) => {
        try {
          const msg = decodeWirePayload(ev.data);
          if (msg) onIncomingMessage(msg, 'wss_aux');
        } catch {}
      };
      aux.onclose = () => { if (state.wsAux === aux) state.wsAux = null; };
    } catch {}
  }

  function sendFastNetplayPacket(pkt) {
    if (!pkt) return;
    if (state.simLossPct > 0 && Math.random() * 100 < state.simLossPct) return;

    const dispatch = () => {
      const wire = encodeNetplayPacketBinary(pkt);
      const mode = ui.transportModeSelect.value;
      const p2pReady = state.rtcChannel?.readyState === 'open';

      const sendWssStriped = () => {
        if (!state.ws || state.ws.readyState !== 1) return;
        state.ws.send(wire);
        const sendAux =
          (pkt.startFrame & 1) === 0 || pkt.hashFrame !== undefined;
        if (sendAux && state.wsAux && state.wsAux.readyState === 1) {
          try { state.wsAux.send(wire); } catch {}
        }
        state.txCountThisSec++;
      };

      if (mode === 'p2p') {
        if (p2pReady) {
          state.rtcChannel.send(wire);
          state.txCountThisSec++;
        }
      } else if (mode === 'wss') {
        sendWssStriped();
      } else if (p2pReady && shouldAutoUseP2p()) {
        state.rtcChannel.send(wire);
        state.txCountThisSec++;
      } else {
        sendWssStriped();
      }
    };

    if (state.simLagMs > 0) {
      setTimeout(dispatch, state.simLagMs);
    } else {
      dispatch();
    }
  }

  return {
    closeWebRtc,
    startWebRtcSession,
    handleWebRtcSignal,
    connectAuxWebSocket,
    sendFastNetplayPacket
  };
}
