/**
 * @fileoverview WebRTC P2P, STUN & ICE Candidate Inspector for `/nettest`.
 *
 * Line width <= 80 chars, file size <= 350 lines.
 */

import { NET_DEBUG_STUN_PROFILES } from './ice_profiles_tables.mjs';

export function createNetDebugWebRtcManager(ctx) {
  const { els, metrics, logEvent } = ctx;
  let rtcPeer = null;
  let dcFast = null;
  let dcReliable = null;
  let pendingRemoteCandidates = [];
  let rtcSignalChain = Promise.resolve();
  let rtcAutoRetryTimer = null;

  function getStunServers() {
    const prof = els.stunProfileSelect.value;
    return NET_DEBUG_STUN_PROFILES[prof] || NET_DEBUG_STUN_PROFILES.mixed;
  }

  function recordIceCandidateRow(side, candStr) {
    if (!candStr) return;
    const parts = candStr.trim().split(/\s+/);
    const proto = (parts[2] || 'udp').toUpperCase();
    const addr = `${parts[4] || '?'}:${parts[5] || '?'}`;
    const typIdx = parts.indexOf('typ');
    const ctype = typIdx >= 0 ? parts[typIdx + 1] : 'unknown';

    metrics.iceCandidates.push({
      side, type: ctype, proto, addr, raw: candStr
    });
    renderIceTable();
  }

  function renderIceTable() {
    if (metrics.iceCandidates.length === 0) {
      els.iceTableBody.innerHTML =
        '<tr><td colspan="4" style="color:var(--muted);">' +
        'No ICE candidates gathered yet.</td></tr>';
      return;
    }
    els.iceTableBody.innerHTML = '';
    for (const c of metrics.iceCandidates) {
      const cls = c.type === 'srflx' || c.type === 'prflx' ? 'ok' : 'warn';
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><strong>${c.side}</strong></td>` +
        `<td><span class="badge ${cls}">${c.type}</span></td>` +
        `<td>${c.proto}</td>` +
        `<td>${c.addr}</td>`;
      els.iceTableBody.appendChild(tr);
    }
  }

  function closeWebRtc() {
    for (const h of [dcFast, dcReliable, rtcPeer]) {
      if (h) {
        try { h.close(); } catch {}
      }
    }
    dcFast = null;
    dcReliable = null;
    rtcPeer = null;
    els.dcFastStateVal.textContent = 'closed';
    els.dcRelStateVal.textContent = 'closed';
    els.rtcOverallBadge.className = 'badge warn';
    els.rtcOverallBadge.textContent = 'CLOSED';
  }

  function bindDataChannel(ch, label) {
    const updateState = () => {
      if (label === 'fast') els.dcFastStateVal.textContent = ch.readyState;
      else els.dcRelStateVal.textContent = ch.readyState;
      const anyOpen =
        dcFast?.readyState === 'open' || dcReliable?.readyState === 'open';
      els.rtcOverallBadge.className = anyOpen ? 'badge ok' : 'badge warn';
      els.rtcOverallBadge.textContent = anyOpen
        ? 'P2P OPEN'
        : ch.readyState.toUpperCase();
    };

    ch.onopen = () => {
      logEvent(`WebRTC DataChannel [${ch.label}] OPEN!`, 'ok');
      updateState();
    };
    ch.onclose = () => {
      logEvent(`WebRTC DataChannel [${ch.label}] closed.`, 'warn');
      updateState();
    };
    ch.onerror = () => {
      logEvent(`WebRTC DataChannel [${ch.label}] error.`, 'err');
      updateState();
    };
    ch.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        ctx.handleIncomingMessage(
          msg,
          label === 'fast' ? 'rtc_fast' : 'rtc_rel'
        );
      } catch {}
    };
    updateState();
  }

  function sendSignalingMessage(signalPayload) {
    const msg = { type: 'webrtc_signal', signal: signalPayload };
    const ws = ctx.getWs();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    } else {
      ctx.enqueueHttp(msg);
      ctx.flushHttpTunnelNow();
    }
  }

  async function startWebRtc(isInitiator) {
    closeWebRtc();
    pendingRemoteCandidates = [];
    metrics.iceCandidates = [];
    renderIceTable();

    if (typeof RTCPeerConnection === 'undefined') {
      logEvent('RTCPeerConnection not supported in this browser.', 'err');
      return;
    }

    const iceServers = getStunServers();
    const roleStr = isInitiator ? 'Initiator' : 'Responder';
    logEvent(
      `Starting WebRTC (${roleStr}) with ${iceServers.length} STUN servers...`
    );

    rtcPeer = new RTCPeerConnection({ iceServers });
    rtcPeer.onicecandidate = (ev) => {
      if (ev.candidate) {
        recordIceCandidateRow('LOCAL', ev.candidate.candidate);
        sendSignalingMessage({ candidate: ev.candidate });
      }
    };

    const updateIceUi = () => {
      if (!rtcPeer) return;
      els.iceStateVal.textContent =
        `${rtcPeer.iceConnectionState} / ${rtcPeer.iceGatheringState}`;
      if (rtcPeer.iceConnectionState === 'failed') {
        els.rtcOverallBadge.className = 'badge err';
        els.rtcOverallBadge.textContent = 'ICE FAILED (UDP Blocked/NAT)';
        logEvent(
          'WebRTC ICE connection FAILED — direct UDP between these 2 ' +
            'networks is blocked by NAT/Firewall.',
          'err'
        );
      }
    };

    rtcPeer.oniceconnectionstatechange = updateIceUi;
    rtcPeer.onicegatheringstatechange = updateIceUi;
    rtcPeer.onconnectionstatechange = updateIceUi;

    if (isInitiator) {
      dcFast = rtcPeer.createDataChannel('diag_fast', {
        ordered: false, maxRetransmits: 0
      });
      dcReliable = rtcPeer.createDataChannel('diag_reliable', {
        ordered: true
      });
      bindDataChannel(dcFast, 'fast');
      bindDataChannel(dcReliable, 'reliable');

      const offer = await rtcPeer.createOffer();
      await rtcPeer.setLocalDescription(offer);
      logEvent('Sent WebRTC SDP Offer to partner...', 'info');
      sendSignalingMessage({ sdp: rtcPeer.localDescription });
    } else {
      rtcPeer.ondatachannel = (ev) => {
        const ch = ev.channel;
        if (ch.label === 'diag_fast') {
          dcFast = ch;
          bindDataChannel(ch, 'fast');
        } else {
          dcReliable = ch;
          bindDataChannel(ch, 'reliable');
        }
      };
    }
  }

  function handleWebRtcSignal(signal) {
    if (!signal) return;
    rtcSignalChain = rtcSignalChain.then(async () => {
      try {
        if (signal.sdp) {
          if (signal.sdp.type === 'offer') {
            logEvent(
              'Received WebRTC SDP Offer from partner — creating Answer...',
              'info'
            );
            await startWebRtc(false);
          } else if (signal.sdp.type === 'answer') {
            logEvent(
              'Received WebRTC SDP Answer from partner — starting ICE...',
              'ok'
            );
          }
          if (!rtcPeer) return;
          await rtcPeer.setRemoteDescription(
            new RTCSessionDescription(signal.sdp)
          );
          if (signal.sdp.type === 'offer') {
            const answer = await rtcPeer.createAnswer();
            await rtcPeer.setLocalDescription(answer);
            logEvent('Sent WebRTC SDP Answer to partner.', 'info');
            sendSignalingMessage({ sdp: rtcPeer.localDescription });
          }
          while (pendingRemoteCandidates.length > 0) {
            const cand = pendingRemoteCandidates.shift();
            recordIceCandidateRow('REMOTE', cand.candidate);
            await rtcPeer.addIceCandidate(new RTCIceCandidate(cand));
          }
        } else if (signal.candidate) {
          if (!rtcPeer?.remoteDescription?.type) {
            pendingRemoteCandidates.push(signal.candidate);
          } else {
            recordIceCandidateRow('REMOTE', signal.candidate.candidate);
            await rtcPeer.addIceCandidate(
              new RTCIceCandidate(signal.candidate)
            );
          }
        }
      } catch (e) {
        logEvent(`WebRTC signaling error: ${e.message}`, 'err');
      }
    });
  }

  function sendViaTransport(transport, payloadObj) {
    const raw = JSON.stringify(payloadObj);
    const ws = ctx.getWs();
    if (transport === 'rtc_fast') {
      if (dcFast?.readyState === 'open') { dcFast.send(raw); return true; }
      return false;
    }
    if (transport === 'rtc_rel') {
      if (dcReliable?.readyState === 'open') {
        dcReliable.send(raw);
        return true;
      }
      return false;
    }
    if (transport === 'http') {
      ctx.enqueueHttp({ ...payloadObj, via: 'http' });
      ctx.flushHttpTunnelNow();
      return true;
    }
    if (transport === 'wss') {
      if (ws?.readyState === 1) { ws.send(raw); return true; }
      return false;
    }
    if (transport === 'auto_reliable') {
      if (dcReliable?.readyState === 'open' && raw.length <= 65536) {
        dcReliable.send(raw);
        return true;
      }
      if (ws?.readyState === 1) { ws.send(raw); return true; }
      ctx.enqueueHttp(payloadObj);
      ctx.flushHttpTunnelNow();
      return true;
    }
    if (dcFast?.readyState === 'open' && raw.length <= 16384) {
      dcFast.send(raw);
      return true;
    }
    if (dcReliable?.readyState === 'open' && raw.length <= 65536) {
      dcReliable.send(raw);
      return true;
    }
    if (ws?.readyState === 1) { ws.send(raw); return true; }
    ctx.enqueueHttp(payloadObj);
    ctx.flushHttpTunnelNow();
    return true;
  }

  function scheduleWebRtcHandshake() {
    if (ctx.getLocalPlayerIndex() !== 1 || !ctx.isPeerConnected()) return;
    if (dcFast?.readyState === 'open') return;
    setTimeout(() => {
      if (ctx.isPeerConnected() && dcFast?.readyState !== 'open') {
        startWebRtc(true);
      }
    }, 300);
    if (rtcAutoRetryTimer) clearTimeout(rtcAutoRetryTimer);
    rtcAutoRetryTimer = setTimeout(() => {
      if (
        ctx.isPeerConnected() &&
        ctx.getLocalPlayerIndex() === 1 &&
        dcFast?.readyState !== 'open' &&
        !rtcPeer?.remoteDescription?.type
      ) {
        logEvent(
          'WebRTC Answer not received yet — retrying WebRTC Offer...',
          'warn'
        );
        startWebRtc(true);
      }
    }, 4500);
  }

  async function pollSelectedCandidatePair() {
    if (!rtcPeer?.getStats) return;
    try {
      const stats = await rtcPeer.getStats();
      stats.forEach((rep) => {
        if (
          rep.type === 'candidate-pair' &&
          rep.state === 'succeeded' &&
          rep.nominated
        ) {
          const loc = stats.get(rep.localCandidateId);
          const rem = stats.get(rep.remoteCandidateId);
          if (loc && rem) {
            els.selectedPairVal.textContent =
              `${loc.candidateType || 'loc'} (${loc.protocol}) ↔ ` +
              `${rem.candidateType || 'rem'}`;
          }
        }
      });
    } catch {}
  }

  return {
    closeWebRtc,
    startWebRtc,
    handleWebRtcSignal,
    sendViaTransport,
    scheduleWebRtcHandshake,
    pollSelectedCandidatePair,
    getRtcPeer: () => rtcPeer,
    getDcFast: () => dcFast,
    getDcReliable: () => dcReliable
  };
}
