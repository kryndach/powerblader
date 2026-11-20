// WebRTC P2P DataChannel & Dual-WebSocket (ws + wsAux) Transport Manager
import { buildWsUrl } from './server_endpoint.mjs';
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19305' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun.nextcloud.com:443' }
];

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
  function closeWebRtc() {
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

  function setupRtcDataChannel(channel) {
    state.rtcChannel = channel;
    ui.dbgRtcState.textContent = 'Connecting...';
    channel.onopen = () => {
      ui.dbgRtcState.textContent = 'OPEN (Direct UDP)';
      ui.logDebug('WebRTC P2P DataChannel OPEN! Using direct UDP link.');
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
        const msg = JSON.parse(ev.data);
        onIncomingMessage(msg, 'p2p');
      } catch {}
    };
  }

  async function startWebRtcSession(isInitiator) {
    closeWebRtc();
    if (typeof RTCPeerConnection === 'undefined') {
      ui.dbgRtcState.textContent = 'Unsupported';
      return;
    }
    try {
      const rtc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      state.rtcPeer = rtc;

      let sdpSent = false;
      rtc.onicecandidate = (ev) => {
        if (
          sdpSent &&
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
        sdpSent = true;
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
    if (!state.rtcPeer) {
      await startWebRtcSession(false);
    }
    const rtc = state.rtcPeer;
    if (!rtc) return;
    try {
      if (signal.sdp) {
        await rtc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
          const answer = await rtc.createAnswer();
          await rtc.setLocalDescription(answer);
          await waitForRtcGathering(rtc, 1200);
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
        await rtc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (e) {
      ui.logDebug(`WebRTC signal warning: ${e.message}`);
    }
  }

  function connectAuxWebSocket(code, cid) {
    if (state.wsAux) {
      try {
        state.wsAux.close();
      } catch {}
      state.wsAux = null;
    }
    if (!code || !cid) return;
    try {
      const auxUrl = buildWsUrl(state, '/ws?aux=1');
      const aux = new WebSocket(auxUrl);
      state.wsAux = aux;
      aux.onopen = () => {
        if (state.wsAux && state.wsAux.readyState === 1) {
          state.wsAux.send(
            JSON.stringify({ type: 'bind_aux', roomCode: code, clientId: cid })
          );
        }
      };
      aux.onmessage = (ev) => {
        try {
          onIncomingMessage(JSON.parse(ev.data), 'wss_aux');
        } catch {}
      };
      aux.onclose = () => {
        if (state.wsAux === aux) state.wsAux = null;
      };
    } catch {}
  }

  function sendFastNetplayPacket(pkt) {
    if (!pkt) return;
    if (state.simLossPct > 0 && Math.random() * 100 < state.simLossPct) return;

    const dispatch = () => {
      const raw = JSON.stringify(pkt);
      const mode = ui.transportModeSelect.value;
      const p2pReady =
        state.rtcChannel && state.rtcChannel.readyState === 'open';

      const sendWssStriped = () => {
        if (!state.ws || state.ws.readyState !== 1) return;
        state.ws.send(raw);
        const sendAux =
          (pkt.startFrame & 1) === 0 || pkt.hashFrame !== undefined;
        if (sendAux && state.wsAux && state.wsAux.readyState === 1) {
          try { state.wsAux.send(raw); } catch {}
        }
        state.txCountThisSec++;
      };

      if (mode === 'p2p') {
        if (p2pReady) {
          state.rtcChannel.send(raw);
          state.txCountThisSec++;
        }
      } else if (mode === 'wss') {
        sendWssStriped();
      } else if (p2pReady) {
        state.rtcChannel.send(raw);
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
