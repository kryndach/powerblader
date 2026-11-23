// Multi-Profile WebRTC P2P & STUN/TURN Matrix Tester for /autotest
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseCandidateType(candStr) {
  if (!candStr || !candStr.trim()) return null;
  const parts = candStr.trim().split(/\s+/);
  const idx = parts.indexOf('typ');
  return idx >= 0 ? parts[idx + 1] : null;
}

export function extractSdpCandidateTypes(sdpStr, targetArr) {
  if (!sdpStr || !Array.isArray(targetArr)) return;
  for (const line of sdpStr.split(/\r?\n/)) {
    if (line.startsWith('a=candidate:')) {
      const t = parseCandidateType(line.slice(2));
      if (t && !targetArr.includes(t)) targetArr.push(t);
    }
  }
}

export function waitForIceGathering(rtc, maxWaitMs = 1200) {
  if (!rtc || rtc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      rtc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const timer = setTimeout(done, maxWaitMs);
    function check() {
      if (rtc.iceGatheringState === 'complete') done();
    }
    rtc.addEventListener('icegatheringstatechange', check);
  });
}

export function createAutotestWebRtcManager(ctx, profiles) {
  let activeRtc = null, activeProfileId = null, activeDcFast = null;
  let activeDcRel = null, pendingCandidates = [];
  let currentRtcProfileResult = null;
  let rtcSignalQueue = Promise.resolve(), rtcPingResolve = null;
  let responderAnswerSent = false, responderGatheredCandidates = [];

  function cleanupRtc() {
    for (const h of [activeDcFast, activeDcRel, activeRtc]) {
      if (h) { try { h.close(); } catch {} }
    }
    activeDcFast = activeDcRel = activeRtc = null;
    pendingCandidates = [];
  }

  function setupDataChannelHandlers(ch) {
    ch.onopen = () => {
      ctx.log(`WebRTC DataChannel [${ch.label}] OPEN!`);
      if (currentRtcProfileResult) currentRtcProfileResult.open = true;
    };
    ch.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'rtc_ping') {
          ch.send(JSON.stringify({ type: 'rtc_pong', t: msg.t }));
        } else if (msg.type === 'rtc_pong' && rtcPingResolve) {
          const r = rtcPingResolve;
          rtcPingResolve = null;
          r(Math.max(1, Math.round(performance.now() - msg.t)));
        }
      } catch {}
    };
  }

  function syncRtcIceState(rtc, resObj, profId) {
    if (!rtc || !resObj) return;
    resObj.iceState =
      `${rtc.signalingState}/${rtc.iceConnectionState}/` +
      `${rtc.iceGatheringState}`;
    ctx.renderTables();
    ctx.sendWs({
      type: 'autotest_rtc_cands',
      profileId: profId,
      candTypes: resObj.localTypes,
      iceState: resObj.iceState
    });
  }

  function bindRtcCandidateCollector(rtc, resObj, profId, list, isSentFn) {
    const onState = () => {
      if (activeRtc === rtc) syncRtcIceState(rtc, resObj, profId);
    };
    rtc.oniceconnectionstatechange = onState;
    rtc.onicegatheringstatechange = onState;
    rtc.onsignalingstatechange = onState;
    rtc.onicecandidate = (ev) => {
      if (activeRtc !== rtc || !ev.candidate?.candidate) return;
      const t = parseCandidateType(ev.candidate.candidate);
      if (t && !resObj.localTypes.includes(t)) resObj.localTypes.push(t);
      const candObj = {
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex
      };
      list.push(candObj);
      syncRtcIceState(rtc, resObj, profId);
      if (isSentFn()) {
        ctx.sendWs({
          type: 'webrtc_signal',
          profileId: profId,
          signal: { candidate: candObj }
        });
      }
    };
  }

  function createProfileResult(prof, iceState = 'new') {
    return {
      id: prof.id, name: prof.name, open: false, iceState,
      localTypes: [], remoteTypes: [], selectedPair: null, rttMs: null
    };
  }

  async function measureDcRtt(dc) {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const rtt = await new Promise((resolve) => {
        const t0 = performance.now();
        const timer = setTimeout(() => {
          rtcPingResolve = null;
          resolve(null);
        }, 1200);
        rtcPingResolve = (val) => { clearTimeout(timer); resolve(val); };
        dc.send(JSON.stringify({ type: 'rtc_ping', t: t0 }));
      });
      if (rtt !== null) samples.push(rtt);
      await sleep(60);
    }
    return ctx.calcStats(samples).avg;
  }

  async function testSingleWebRtcProfile(prof) {
    cleanupRtc();
    activeProfileId = prof.id;
    const resObj = createProfileResult(prof, 'new');
    currentRtcProfileResult = resObj;
    ctx.reportState.webrtcProfiles.push(resObj);
    ctx.renderTables();

    ctx.log(`Testing WebRTC ${prof.name}...`);
    const rtc = new RTCPeerConnection({ iceServers: prof.iceServers });
    activeRtc = rtc;

    let offerSent = false;
    const gatheredLocal = [];
    bindRtcCandidateCollector(
      rtc, resObj, prof.id, gatheredLocal, () => offerSent
    );

    activeDcFast = rtc.createDataChannel('diag_fast', {
      ordered: false, maxRetransmits: 0
    });
    activeDcRel = rtc.createDataChannel('diag_reliable', { ordered: true });
    setupDataChannelHandlers(activeDcFast);
    setupDataChannelHandlers(activeDcRel);

    const offer = await rtc.createOffer();
    await rtc.setLocalDescription(offer);
    await waitForIceGathering(rtc, 1200);
    extractSdpCandidateTypes(rtc.localDescription?.sdp, resObj.localTypes);
    syncRtcIceState(rtc, resObj, prof.id);
    offerSent = true;
    ctx.sendWs({
      type: 'webrtc_signal',
      profileId: prof.id,
      signal: {
        sdp: {
          type: rtc.localDescription.type, sdp: rtc.localDescription.sdp
        },
        candidates: gatheredLocal
      }
    });

    const startWait = performance.now();
    while (performance.now() - startWait < 4500) {
      if (activeDcFast?.readyState === 'open') {
        resObj.open = true;
        break;
      }
      await sleep(120);
    }

    if (activeRtc === rtc) {
      syncRtcIceState(rtc, resObj, prof.id);
      try {
        const stats = await rtc.getStats();
        stats.forEach((rep) => {
          const isOk = rep.state === 'succeeded' || rep.nominated;
          if (rep.type === 'candidate-pair' && isOk) {
            const loc = stats.get(rep.localCandidateId);
            const rem = stats.get(rep.remoteCandidateId);
            if (loc && rem) {
              resObj.selectedPair =
                `${loc.candidateType}(${loc.protocol})↔${rem.candidateType}`;
            }
          }
        });
      } catch {}
    }

    if (resObj.open && activeDcFast?.readyState === 'open') {
      const avg = await measureDcRtt(activeDcFast);
      resObj.rttMs = avg;
      ctx.reportState.rtcFastRttMs = avg;
      ctx.log(
        `WebRTC Profile "${prof.id}" SUCCEEDED! Pair=${resObj.selectedPair}, ` +
          `P2P RTT=${avg}ms`
      );
    } else {
      ctx.log(
        `WebRTC Profile "${prof.id}" blocked/timed out ` +
          `(ICE=${resObj.iceState}, Local=[${resObj.localTypes.join(',')}], ` +
          `Remote=[${resObj.remoteTypes.join(',')}]).`
      );
    }
    ctx.renderTables();
    return resObj;
  }

  function handleResponderRtcInit(profileId) {
    const prof = profiles.find((p) => p.id === profileId) || profiles[0];
    cleanupRtc();
    responderAnswerSent = false;
    responderGatheredCandidates = [];
    activeProfileId = prof.id;
    let resObj = ctx.reportState.webrtcProfiles.find((p) => p.id === prof.id);
    if (!resObj) {
      resObj = createProfileResult(prof, 'responder');
      ctx.reportState.webrtcProfiles.push(resObj);
    }
    currentRtcProfileResult = resObj;
    ctx.renderTables();

    const rtc = new RTCPeerConnection({ iceServers: prof.iceServers });
    activeRtc = rtc;
    bindRtcCandidateCollector(
      rtc, resObj, prof.id, responderGatheredCandidates,
      () => responderAnswerSent
    );
    rtc.ondatachannel = (ev) => {
      const ch = ev.channel;
      if (ch.label === 'diag_fast') activeDcFast = ch;
      else activeDcRel = ch;
      setupDataChannelHandlers(ch);
    };
  }

  function recordRemoteCand(cur, candStr) {
    const t = parseCandidateType(candStr);
    if (t && cur && !cur.remoteTypes.includes(t)) cur.remoteTypes.push(t);
  }

  function handleIncomingWebRtcSignal(signal, profileId) {
    if (!signal) return;
    rtcSignalQueue = rtcSignalQueue.then(async () => {
      try {
        const targetProfId = profileId || activeProfileId || 'alt_udp_ports';
        if (signal.sdp?.type === 'offer') handleResponderRtcInit(targetProfId);
        if (!activeRtc) return;
        if (profileId && activeProfileId && profileId !== activeProfileId) {
          return;
        }
        const cur = currentRtcProfileResult;
        if (signal.sdp) {
          if (cur && signal.sdp.sdp) {
            extractSdpCandidateTypes(signal.sdp.sdp, cur.remoteTypes);
          }
          await activeRtc.setRemoteDescription(
            new RTCSessionDescription(signal.sdp)
          );
          for (const c of signal.candidates || []) {
            recordRemoteCand(cur, c.candidate);
            try { await activeRtc.addIceCandidate(new RTCIceCandidate(c)); }
            catch {}
          }
          if (signal.sdp.type === 'offer') {
            const ans = await activeRtc.createAnswer();
            await activeRtc.setLocalDescription(ans);
            await waitForIceGathering(activeRtc, 1200);
            if (cur) {
              extractSdpCandidateTypes(
                activeRtc.localDescription?.sdp, cur.localTypes
              );
            }
            syncRtcIceState(activeRtc, cur, targetProfId);
            responderAnswerSent = true;
            const locStr = cur ? cur.localTypes.join(',') : '';
            ctx.log(
              `WebRTC Responder answered "${targetProfId}" ` +
                `(ICE=${cur?.iceState}, Local=[${locStr}])`
            );
            ctx.sendWs({
              type: 'webrtc_signal',
              profileId: targetProfId,
              signal: {
                sdp: {
                  type: activeRtc.localDescription.type,
                  sdp: activeRtc.localDescription.sdp
                },
                candidates: responderGatheredCandidates
              }
            });
          } else if (signal.sdp.type === 'answer') {
            syncRtcIceState(activeRtc, cur, targetProfId);
            ctx.log(
              `WebRTC Offerer received SDP Answer for "${targetProfId}" ` +
                `(ICE=${cur?.iceState}, Remote=[${cur?.remoteTypes.join(',')}])`
            );
          }
          while (pendingCandidates.length > 0) {
            const c = pendingCandidates.shift();
            recordRemoteCand(cur, c.candidate);
            await activeRtc.addIceCandidate(new RTCIceCandidate(c));
          }
        } else if (signal.candidate) {
          recordRemoteCand(cur, signal.candidate.candidate);
          if (!activeRtc.remoteDescription?.type) {
            pendingCandidates.push(signal.candidate);
          } else {
            await activeRtc.addIceCandidate(
              new RTCIceCandidate(signal.candidate)
            );
          }
        }
        ctx.renderTables();
      } catch (e) {
        ctx.log(`WebRTC signal error: ${e.message}`);
      }
    });
  }

  return {
    cleanupRtc,
    testSingleWebRtcProfile,
    handleResponderRtcInit,
    handleIncomingWebRtcSignal
  };
}
