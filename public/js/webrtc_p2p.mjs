// WebRTC P2P DataChannel & Dual-WebSocket (ws + wsAux) Transport Manager
import { buildWsUrl } from './server_endpoint.mjs';
import {
  buildGameplayIceServers, classifyIceCandidateType
} from './ice_config.mjs';
import { createMultiPathRacer } from './multipath_racer.mjs';
import {
  encodeNetplayPacketBinary, decodeNetplayPacketBinary, isBinaryNetplayPacket
} from '../../src/binary_net_codec.mjs';

function waitForRtcGathering(rtc, maxWaitMs = 1200) {
  if (!rtc || rtc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      rtc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, maxWaitMs);
    function check() {
      if (rtc.iceGatheringState === 'complete') {
        clearTimeout(t);
        rtc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    }
    rtc.addEventListener('icegatheringstatechange', check);
  });
}

export function createNetTransport(state, ui, onIncomingMessage) {
  const racer = createMultiPathRacer();
  state.multipathRacer = racer;
  let rtcPathKind = 'direct_p2p';

  function closeWebRtc() {
    racer.removePath('p2p');
    if (state.rtcChannel) {
      try {
        state.rtcChannel.close();
      } catch {}
      state.rtcChannel = null;
    }
    if (state.rtcPeer) {
      try {
        state.rtcPeer.close();
      } catch {}
      state.rtcPeer = null;
    }
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
    const p2p = state.p2pRttMs, wss = state.wssRttMs;
    if (p2p > 0) {
      racer.setPathMetrics('p2p', {
        kind: rtcPathKind,
        label: rtcPathKind === 'turn_443' ? 'TURN/443' : 'Direct P2P',
        rttMs: p2p
      });
    }
    if (wss > 0) {
      racer.setPathMetrics('wss', {
        kind: 'wss', label: 'WSS Relay', rttMs: wss
      });
    }
    if (wss > 0 && p2p > 0) {
      const winner = racer.selectActivePath();
      if (winner) {
        state._usingP2pAuto = winner.id === 'p2p';
        return state._usingP2pAuto;
      }
    } else if (state._usingP2pAuto === undefined) {
      state._usingP2pAuto = true;
    }
    return state._usingP2pAuto;
  }

  async function reportRealIceType(rtc) {
    if (!rtc?.getStats) return;
    try {
      const stats = await rtc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' &&
            (r.selected || r.state === 'succeeded')) {
          if (!pair || r.selected) pair = r;
        }
      });
      if (!pair || state.rtcPeer !== rtc) return;
      const loc = stats.get(pair.localCandidateId);
      const proto = String(loc?.protocol || 'udp').toUpperCase();
      const kind = loc?.candidateType || 'direct';
      rtcPathKind = classifyIceCandidateType(kind);
      ui.dbgRtcState.textContent = `OPEN (${proto} ${kind})`;
      ui.updateStatusStrip();
    } catch {}
  }

  function setupRtcDataChannel(channel) {
    state.rtcChannel = channel;
    try { channel.binaryType = 'arraybuffer'; } catch {}
    ui.dbgRtcState.textContent = 'Connecting...';
    channel.onopen = () => {
      ui.dbgRtcState.textContent = 'OPEN (Probing...)';
      ui.logDebug('WebRTC P2P DataChannel OPEN! Probing RTT vs WSS.');
      try {
        channel.send(encodeNetplayPacketBinary({
          type: 'peer_ping', t: Date.now()
        }));
      } catch {}
      setTimeout(() => reportRealIceType(state.rtcPeer), 400);
      ui.updateStatusStrip();
    };
    channel.onclose = () => {
      ui.dbgRtcState.textContent = 'Closed (WSS Fallback)';
      ui.logDebug('WebRTC DataChannel closed; falling back to WSS Relay.');
      ui.updateStatusStrip();
    };
    channel.onerror = () => {
      ui.dbgRtcState.textContent = 'Blocked (Using WSS)';
      ui.updateStatusStrip();
    };
    channel.onmessage = (ev) => {
      try {
        const msg = decodeWirePayload(ev.data);
        if (msg) onIncomingMessage(msg, 'p2p');
      } catch {}
    };
  }

  async function flushPendingIce(rtc) {
    const q = rtc?._pendingIce;
    if (!q?.length || !rtc.remoteDescription) return;
    rtc._pendingIce = [];
    for (const cand of q) {
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
          rtc._sdpSent &&
          ev.candidate &&
          ev.candidate.candidate &&
          state.ws &&
          state.ws.readyState === 1
        ) {
          state.ws.send(
            JSON.stringify({
              type: 'webrtc_signal',
              signal: { candidate: ev.candidate }
            })
          );
        }
      };

      rtc.onconnectionstatechange = () => {
        if (!state.rtcPeer) return;
        const st = state.rtcPeer.connectionState;
        if (st === 'failed' || st === 'disconnected') {
          ui.dbgRtcState.textContent = `Fallback (${st})`;
          ui.updateStatusStrip();
        }
      };

      if (isInitiator) {
        const dc = rtc.createDataChannel('nes_netplay', {
          ordered: false,
          maxRetransmits: 0
        });
        setupRtcDataChannel(dc);
        const offer = await rtc.createOffer();
        await rtc.setLocalDescription(offer);
        await waitForRtcGathering(rtc, 1200);
        rtc._sdpSent = true;
        if (state.ws && state.ws.readyState === 1 && rtc.localDescription) {
          state.ws.send(
            JSON.stringify({
              type: 'webrtc_signal',
              signal: { sdp: rtc.localDescription }
            })
          );
        }
      } else {
        rtc.ondatachannel = (ev) => setupRtcDataChannel(ev.channel);
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
        await flushPendingIce(rtc);
        if (signal.sdp.type === 'offer') {
          const answer = await rtc.createAnswer();
          await rtc.setLocalDescription(answer);
          await waitForRtcGathering(rtc, 1200);
          rtc._sdpSent = true;
          if (state.ws && state.ws.readyState === 1 && rtc.localDescription) {
            state.ws.send(
              JSON.stringify({
                type: 'webrtc_signal',
                signal: { sdp: rtc.localDescription }
              })
            );
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
