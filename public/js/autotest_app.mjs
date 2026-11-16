// Main Application Entry Point for `/autotest` (AUTOBENCH v3.0)
import { AUTOTEST_WEBRTC_PROFILES } from './ice_profiles_tables.mjs';
import { createAutotestWebRtcManager } from './autotest_webrtc.mjs';
import {
  calcStats, createAutotestStagesManager
} from './autotest_stages.mjs';
import {
  createAutotestNetplayAndHttpManager
} from './autotest_netplay_and_http.mjs';
import { runFullAutoBenchmark } from './autotest_runner.mjs';

const el = (id) => document.getElementById(id);
const els = {
  stateBadge: el('stateBadge'), stateText: el('stateText'),
  roleLabel: el('roleLabel'), partnerLabel: el('partnerLabel'),
  progressBar: el('progressBar'), suiteBadge: el('suiteBadge'),
  p2pBadge: el('p2pBadge'), stagesBody: el('stagesBody'),
  rtcBody: el('rtcBody'), reportBox: el('reportBox'),
  rerunBtn: el('rerunBtn'), copyBtn: el('copyBtn'), copyBtn2: el('copyBtn2')
};

let clientId = sessionStorage.getItem('nes_autotest_cid');
if (!clientId) {
  clientId = `auto_${Date.now().toString(36)}_${
    Math.random().toString(36).slice(2, 7)
  }`;
  sessionStorage.setItem('nes_autotest_cid', clientId);
}

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('room') || 'AUTO').trim().toUpperCase();
const gameRoom = (params.get('gameRoom') || 'NOVA').trim().toUpperCase();
const backBtn = el('backToGameBtn');
if (backBtn) backBtn.href = `/?room=${encodeURIComponent(gameRoom)}`;

let ws = null, wsAux = null, localPlayerIndex = 1, peerConnected = false;
let suiteRunning = false, autoStartedOnce = false, reconnectTimer = null;

const logs = [];
function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ` +
    `[PC${localPlayerIndex}] ${msg}`;
  logs.push(line);
  if (logs.length > 150) logs.shift();
  console.log(line);
}

const reportState = {
  playerIndex: 1, url: window.location.href,
  userAgent: navigator.userAgent.slice(0, 90),
  overallStatus: 'WAITING', activeTransport: 'WSS Relay', dualWsOk: false,
  serverRttMs: null, wssRttMs: null, wssJitterMs: 0,
  rtcFastRttMs: null, rtcRelRttMs: null,
  httpBench: null, wasmBench: null, liveNetplay: null, recommendations: null,
  stages: [], webrtcProfiles: [], logs
};

function renderTables() {
  if (reportState.stages.length > 0) {
    els.stagesBody.innerHTML = '';
    for (const s of reportState.stages) {
      const map = { PASS: 'ok', WARN: 'warn', RUNNING: 'info' };
      const cls = map[s.status] || 'err';
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><strong>${s.name}</strong></td>` +
        `<td><span class="badge ${cls}">${s.status}</span></td>` +
        `<td>${s.summary}</td>`;
      els.stagesBody.appendChild(tr);
    }
  }
  if (reportState.webrtcProfiles.length > 0) {
    els.rtcBody.innerHTML = '';
    for (const p of reportState.webrtcProfiles) {
      const cls = p.open ? 'ok' : 'warn';
      const label = p.open ? 'P2P OPEN' : p.iceState.toUpperCase();
      const locStr = (p.localTypes || []).join(',') || 'none';
      const remStr = (p.remoteTypes || []).join(',') || 'none';
      const pairStr = p.selectedPair || '--';
      const rttStr = p.rttMs !== null ? `${p.rttMs} ms` : '--';
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><strong>${p.name}</strong></td>` +
        `<td><span class="badge ${cls}">${label}</span></td>` +
        `<td>Local:[${locStr}] ↔ Remote:[${remStr}] (${pairStr})</td>` +
        `<td><strong>${rttStr}</strong></td>`;
      els.rtcBody.appendChild(tr);
    }
  }
}

function sendWs(obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function sendDualWs(obj) {
  const raw = JSON.stringify(obj);
  let sent = false;
  if (ws && ws.readyState === 1) { ws.send(raw); sent = true; }
  if (wsAux && wsAux.readyState === 1) {
    try { wsAux.send(raw); sent = true; } catch {}
  }
  return sent;
}

async function uploadReportToServer(isFinal = false) {
  reportState.playerIndex = localPlayerIndex;
  if (localPlayerIndex !== 1 && !isFinal) return;
  const sentViaWs = sendWs({
    type: 'autotest_report_ws',
    report: { ...reportState, isFinal }
  });
  if (localPlayerIndex === 1 || !sentViaWs || isFinal) {
    try {
      const res = await fetch('/api/autotest-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...reportState, isFinal })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.combinedText) els.reportBox.value = data.combinedText;
      }
    } catch {}
  }
}

const ctx = {
  els, roomCode, reportState, log, sendWs, sendDualWs, renderTables,
  uploadReportToServer, calcStats,
  isSuiteRunning: () => suiteRunning,
  setSuiteRunning: (v) => { suiteRunning = Boolean(v); },
  isPeerConnected: () => peerConnected
};

const webrtcMgr = createAutotestWebRtcManager(ctx, AUTOTEST_WEBRTC_PROFILES);
const stagesMgr = createAutotestStagesManager(
  ctx, webrtcMgr, AUTOTEST_WEBRTC_PROFILES
);
const fullStackMgr = createAutotestNetplayAndHttpManager(ctx);

function triggerBenchmark() {
  runFullAutoBenchmark(
    ctx, stagesMgr, webrtcMgr, fullStackMgr, AUTOTEST_WEBRTC_PROFILES
  );
}

async function handleSyncMessage(msg) {
  if (Array.isArray(msg.stages)) reportState.stages = msg.stages;
  if (msg.httpBench !== undefined) reportState.httpBench = msg.httpBench;
  if (msg.wasmBench !== undefined) reportState.wasmBench = msg.wasmBench;
  if (msg.liveNetplay !== undefined) reportState.liveNetplay = msg.liveNetplay;
  if (msg.recommendations !== undefined) {
    reportState.recommendations = msg.recommendations;
  }
  if (Array.isArray(msg.webrtcProfiles)) {
    for (const inc of msg.webrtcProfiles) {
      const loc = reportState.webrtcProfiles.find((p) => p.id === inc.id);
      if (loc) {
        loc.open = inc.open;
        loc.rttMs = inc.rttMs;
        loc.selectedPair = inc.selectedPair || loc.selectedPair;
        for (const ct of inc.localTypes || []) {
          if (!loc.remoteTypes.includes(ct)) loc.remoteTypes.push(ct);
        }
      } else {
        reportState.webrtcProfiles.push(inc);
      }
    }
  }
  if (typeof msg.progress === 'number') {
    els.progressBar.style.width = `${msg.progress}%`;
  }
  renderTables();
  if (msg.complete) {
    reportState.overallStatus = 'COMPLETE';
    els.suiteBadge.className = 'badge ok';
    els.suiteBadge.textContent = 'COMPLETE';
    els.stateBadge.className = 'badge ok';
    els.stateBadge.textContent = 'BENCHMARK COMPLETE';
    els.stateText.textContent =
      'All 8 benchmark stages finished and auto-saved to ' +
      'logs/autotest_latest.txt!';
    await uploadReportToServer(true);
  } else {
    await uploadReportToServer(false);
  }
}

function connectAuxSocket() {
  if (wsAux) { try { wsAux.close(); } catch {} wsAux = null; }
  reportState.dualWsOk = false;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const aux = new WebSocket(`${proto}//${window.location.host}/ws?aux=1`);
  wsAux = aux;
  aux.onopen = () => {
    aux.send(JSON.stringify({ type: 'bind_aux', roomCode, clientId }));
  };
  aux.onmessage = (ev) => {
    try { dispatchIncoming(JSON.parse(ev.data)); } catch {}
  };
  aux.onclose = () => { if (wsAux === aux) wsAux = null; };
}

async function dispatchIncoming(msg) {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'aux_bound') {
    reportState.dualWsOk = true;
    log('Bound Dual-WebSocket auxiliary stripe (wsAux).');
    return;
  }
  if (await fullStackMgr.handleMessage(msg)) return;
  if (msg.type === 'pong') return stagesMgr.resolveServerPong();
  if (msg.type === 'autotest_combined_text' && msg.combinedText) {
    els.reportBox.value = msg.combinedText;
    return;
  }
  if (msg.type === 'room_joined' || msg.type === 'peer_joined') {
    if (msg.playerIndex) localPlayerIndex = msg.playerIndex;
    if (msg.type === 'room_joined') connectAuxSocket();
    els.roleLabel.textContent = `You: PC ${localPlayerIndex}`;
    const others = (msg.peers || []).filter((p) =>
      p.clientId ? p.clientId !== clientId : p.playerIndex !== localPlayerIndex
    );
    peerConnected = others.length > 0;
    if (peerConnected) {
      els.partnerLabel.textContent =
        `Partner: PC ${others[0].playerIndex} (LINKED)`;
      if (!suiteRunning && !autoStartedOnce) {
        autoStartedOnce = true;
        els.stateBadge.className = 'badge info';
        els.stateBadge.textContent = '2 PCs LINKED';
        els.stateText.textContent =
          '2nd PC detected! Starting 8-stage benchmark in 1.2s...';
        reportState.serverRttMs = await stagesMgr.measureServerRtt();
        await uploadReportToServer(false);
        if (localPlayerIndex === 1) setTimeout(triggerBenchmark, 1200);
      }
    }
    return;
  }
  if (msg.type === 'peer_left') {
    peerConnected = false;
    els.partnerLabel.textContent = 'Partner: Disconnected';
    els.stateBadge.className = 'badge warn';
    els.stateBadge.textContent = 'PARTNER LEFT';
    return;
  }
  if (msg.type === 'autotest_ping') {
    return sendWs({ type: 'autotest_pong', pingId: msg.pingId, t: msg.t });
  }
  if (msg.type === 'autotest_pong') {
    return stagesMgr.resolvePeerPong(msg.pingId);
  }
  if (msg.type === 'autotest_req_srv_rtt') {
    reportState.serverRttMs = await stagesMgr.measureServerRtt();
    return uploadReportToServer(false);
  }
  if (msg.type === 'autotest_rtc_init') {
    return webrtcMgr.handleResponderRtcInit(msg.profileId);
  }
  if (msg.type === 'autotest_rtc_cands') {
    const p = reportState.webrtcProfiles.find((x) => x.id === msg.profileId);
    if (p && Array.isArray(msg.candTypes)) {
      for (const ct of msg.candTypes) {
        if (!p.remoteTypes.includes(ct)) p.remoteTypes.push(ct);
      }
      renderTables();
    }
    return;
  }
  if (msg.type === 'autotest_trigger_rerun') {
    if (localPlayerIndex === 1 && !suiteRunning) triggerBenchmark();
    return;
  }
  if (msg.type === 'webrtc_signal') {
    return webrtcMgr.handleIncomingWebRtcSignal(msg.signal, msg.profileId);
  }
  if (msg.type === 'autotest_start_bidir_stream') {
    stagesMgr.startRxStream(msg.totalFrames || 180);
    stagesMgr.startLocal60HzTx(msg.totalFrames || 180);
    return;
  }
  if (msg.type === 'autotest_stream_pkt') {
    return stagesMgr.handleStreamPacket(msg);
  }
  if (msg.type === 'autotest_stream_done') {
    return stagesMgr.sendStreamReportIfNeeded();
  }
  if (msg.type === 'autotest_stream_report') {
    return stagesMgr.handleStreamReport(msg);
  }
  if (msg.type === 'diag_xfer_start') return stagesMgr.handleXferStart(msg);
  if (msg.type === 'diag_xfer_chunk') return stagesMgr.handleXferChunk(msg);
  if (msg.type === 'diag_xfer_end') return stagesMgr.handleXferEnd(msg);
  if (msg.type === 'diag_xfer_ack') return stagesMgr.handleXferAck(msg);
  if (msg.type === 'autotest_sync') await handleSyncMessage(msg);
}

function connectAutoRoom() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${window.location.host}/ws`);
  ws.onopen = () => {
    log(`Connected to WebSocket (${ws.url}) — joining "${roomCode}"...`);
    sendWs({ type: 'join_room', roomCode, clientId, nick: 'PC' });
  };
  ws.onclose = (ev) => {
    log(`WebSocket closed (code=${ev.code}) — reconnecting in 800ms...`);
    reconnectTimer = setTimeout(connectAutoRoom, 800);
  };
  ws.onmessage = (ev) => {
    try { dispatchIncoming(JSON.parse(ev.data)); } catch {}
  };
}

els.rerunBtn.addEventListener('click', () => {
  if (!peerConnected) return;
  if (localPlayerIndex === 1) triggerBenchmark();
  else sendWs({ type: 'autotest_trigger_rerun' });
});

function copyReport() {
  navigator.clipboard.writeText(els.reportBox.value).then(() => {
    els.copyBtn.textContent = '✔ Copied!';
    els.copyBtn2.textContent = '✔ Copied!';
    setTimeout(() => {
      els.copyBtn.textContent = '📋 Copy Full Report';
      els.copyBtn2.textContent = '📋 Copy Report to Clipboard';
    }, 1600);
  });
}
els.copyBtn.addEventListener('click', copyReport);
els.copyBtn2.addEventListener('click', copyReport);

connectAutoRoom();
