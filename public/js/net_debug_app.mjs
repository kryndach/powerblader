// Main Application Entry Point for /nettest (2-PC Network Debugger)
import { createNetDebugWebRtcManager } from './net_debug_webrtc.mjs';
import { createNetDebugSuitesManager } from './net_debug_suites.mjs';
import { createNetDebugArenaManager } from './net_debug_arena.mjs';
import {
  resolveServerEndpoints, buildApiUrl, buildWsUrl, buildSubPageUrl,
  resolveStoredRoomAuth, verifyDiagBackendOrWarn
} from './server_endpoint.mjs';

const els = new Proxy({}, { get: (_, id) => document.getElementById(id) });
const endpoints = resolveServerEndpoints();
const srv = endpoints.apiBaseUrl;
const params = new URLSearchParams(window.location.search);
if (params.get('room')) els.roomInput.value = params.get('room').toUpperCase();
if (params.get('nick')) els.nickInput.value = params.get('nick').slice(0, 14);
const initRm = els.roomInput.value;
els.backToNesLink.href = buildSubPageUrl('./', { room: initRm }, srv);
if (els.autoTestLink) {
  els.autoTestLink.href = buildSubPageUrl(
    './autotest.html', { gameRoom: initRm }, srv
  );
}
let backendReady = false, roomAuth = '';
const logHistory = [];
function logEvent(msg, level = 'info') {
  const ts = new Date().toISOString().slice(11, 23);
  logHistory.push({ ts, level, msg });
  if (logHistory.length > 200) logHistory.shift();
  const div = document.createElement('div');
  div.className = `log-line ${level}`;
  div.textContent = `[${ts}] ${msg}`;
  els.logBox.prepend(div);
  while (els.logBox.children.length > 80) els.logBox.lastChild.remove();
}
els.clearLogBtn.addEventListener('click', () => { els.logBox.innerHTML = ''; });
let clientId = sessionStorage.getItem('nes_netbench_client_id');
if (!clientId) {
  clientId = `c_${Date.now().toString(36)}`;
  sessionStorage.setItem('nes_netbench_client_id', clientId);
}

let ws = null, httpTunnelActive = false, httpPollingBusy = false;
const httpOutQueue = [], seenSeqSet = new Set(), seenAccessEntries = new Set();
let highestSeqSeen = 0, roomCode = null, localPlayerIndex = 1;
let peerConnected = false, peerNick = 'Remote PC';
let peerTransports = { wsOpen: false, httpActive: false };
let wsDropCount = 0, lastWsCloseCode = '--', wsFallbackTimer = null;

const newBucket = () => ({ rtt: null, jitter: 0, tx: 0, rx: 0, samples: [] });
const metrics = {
  serverRttMs: null,
  wssPeer: newBucket(), httpPeer: newBucket(),
  rtcFast: newBucket(), rtcRel: newBucket(),
  iceCandidates: [], transfers: [], lastStreamReport: null,
  suiteResults: [], serverAccessLog: []
};

function recordRttSample(b, sampleMs) {
  const s = Math.max(1, Math.round(sampleMs));
  b.jitter = b.rtt === null ? 0
    : Math.round(b.jitter * 0.7 + Math.abs(s - b.rtt) * 0.3);
  b.rtt = b.rtt === null ? s : Math.round(b.rtt * 0.7 + s * 0.3);
  b.rx++; b.samples.push(s);
  if (b.samples.length > 30) b.samples.shift();
}
function flushHttpTunnelNow() {
  if (httpOutQueue.length > 0 && !httpPollingBusy) pollHttpTunnel(false);
}
const ctx = {
  els, metrics, logEvent, getWs: () => ws,
  enqueueHttp: (m) => httpOutQueue.push(m),
  flushHttpTunnelNow, isPeerConnected: () => peerConnected,
  getLocalPlayerIndex: () => localPlayerIndex,
  handleIncomingMessage: (msg, via) => handleIncomingMessage(msg, via)
};
const webrtcMgr = createNetDebugWebRtcManager(ctx);
const suitesMgr = createNetDebugSuitesManager(ctx, webrtcMgr);
const arenaMgr = createNetDebugArenaManager(ctx, webrtcMgr, suitesMgr);

function updateRoomBanner() {
  els.localRoleLabel.textContent = `You: PC ${localPlayerIndex}`;
  els.peerRoleLabel.textContent = peerConnected
    ? `Partner: ${peerNick} (WS:${peerTransports.wsOpen ? 'OK' : 'NO'}, ` +
      `HTTP:${peerTransports.httpActive ? 'OK' : '--'})`
    : 'Partner: Waiting...';
  els.activePeersBadge.className = peerConnected ? 'badge ok' : 'badge warn';
  els.activePeersBadge.textContent = peerConnected
    ? '2 / 2 PCs READY' : '1 / 2 PCs';

  const wsOpen = ws && ws.readyState === 1;
  if (!wsOpen && !httpTunnelActive) {
    els.roomBadge.className = 'badge err';
    els.roomBadge.textContent = 'OFFLINE';
    els.roomStatusText.textContent = 'Disconnected — Click "Connect Room"';
  } else if (!peerConnected) {
    els.roomBadge.className = 'badge warn';
    els.roomBadge.textContent = `ROOM "${roomCode}"`;
    els.roomStatusText.textContent =
      `Waiting for 2nd PC to open /nettest?room=${roomCode}... ` +
      `(WSS: ${wsOpen ? 'OPEN' : 'BLOCKED'}, ` +
      `HTTPS: ${httpTunnelActive ? 'OPEN' : '...'})`;
  } else {
    els.roomBadge.className = 'badge ok';
    els.roomBadge.textContent = `2-PC LINKED [${roomCode}]`;
    els.roomStatusText.textContent =
      `Connected with "${peerNick}" — Click "▶ Run Auto Suite (2-PC)"!`;
  }
}

function syncRoomPeersList(peersList) {
  if (!Array.isArray(peersList)) return;
  const others = peersList.filter((p) =>
    p.clientId ? p.clientId !== clientId : p.playerIndex !== localPlayerIndex
  );
  const wasConnected = peerConnected;
  const prevWsOpen = peerTransports.wsOpen;
  peerConnected = others.length > 0;
  if (peerConnected) {
    const partner = others[0];
    peerNick = partner.nick || `PC ${partner.playerIndex}`;
    peerTransports = {
      wsOpen: Boolean(partner.wsOpen),
      httpActive: Boolean(partner.httpActive)
    };
    if (!wasConnected || (!prevWsOpen && peerTransports.wsOpen)) {
      logEvent(
        `Partner "${peerNick}" ready in room "${roomCode}" ` +
          `(WS=${peerTransports.wsOpen ? 'OPEN' : 'CLOSED'}, ` +
          `HTTPS=${peerTransports.httpActive ? 'ACTIVE' : 'STANDBY'})!`, 'ok'
      );
      const rtcPeer = webrtcMgr.getRtcPeer();
      if (
        localPlayerIndex === 1 &&
        (!rtcPeer || (!prevWsOpen && peerTransports.wsOpen))
      ) {
        webrtcMgr.scheduleWebRtcHandshake();
      }
    }
  }
  updateRoomBanner();
}

function handleIncomingMessage(msg, viaSource) {
  if (!msg || typeof msg.type !== 'string') return;
  if (typeof msg._seq === 'number') {
    if (seenSeqSet.has(msg._seq)) return;
    seenSeqSet.add(msg._seq);
    if (seenSeqSet.size > 2000) {
      seenSeqSet.delete(seenSeqSet.values().next().value);
    }
    if (msg._seq > highestSeqSeen) highestSeqSeen = msg._seq;
  }

  if (msg.type === 'pong') {
    metrics.serverRttMs = Math.max(1, Date.now() - msg.t);
    els.srvRttVal.textContent = `${metrics.serverRttMs} ms`;
    return;
  }
  if (msg.type === 'room_joined') {
    roomCode = msg.roomCode;
    localPlayerIndex = msg.playerIndex;
    syncRoomPeersList(msg.peers);
    return logEvent(`Joined "${roomCode}" as PC ${localPlayerIndex}`, 'ok');
  }
  if (msg.type === 'peer_joined') {
    return syncRoomPeersList(msg.peers || (msg.peer ? [msg.peer] : []));
  }
  if (msg.type === 'peer_left') {
    peerConnected = false;
    webrtcMgr.closeWebRtc();
    updateRoomBanner();
    return logEvent(`Partner left room "${roomCode}".`, 'warn');
  }
  if (msg.type === 'webrtc_signal') {
    return webrtcMgr.handleWebRtcSignal(msg.signal);
  }
  if (msg.type === 'peer_ping') {
    const v = msg.via || viaSource;
    return webrtcMgr.sendViaTransport(v, {
      type: 'peer_pong', via: v, t: msg.t
    });
  }
  if (msg.type === 'peer_pong') {
    const map = {
      rtc_fast: [metrics.rtcFast, els.rtcFastRttVal],
      rtc_rel: [metrics.rtcRel, els.rtcRelRttVal],
      http: [metrics.httpPeer, els.httpPeerRttVal]
    };
    const [b, el] = map[msg.via] || [metrics.wssPeer, els.wssPeerRttVal];
    recordRttSample(b, performance.now() - msg.t);
    el.textContent = `${b.rtt} ms (±${b.jitter}ms)`;
    els.wssPingCountVal.textContent =
      `WSS:${metrics.wssPeer.rx}/${metrics.wssPeer.tx} | ` +
      `HTTP:${metrics.httpPeer.rx}/${metrics.httpPeer.tx}`;
    return;
  }
  if (suitesMgr.handleXferMessage(msg, viaSource)) return;
  if (suitesMgr.handleStreamMessage(msg, viaSource)) return;
  if (msg.type === 'diag_suite_results') {
    metrics.suiteResults = msg.suiteResults || [];
    els.suiteStatusBadge.className = 'badge ok';
    els.suiteStatusBadge.textContent = 'COMPLETE (SYNCED)';
    return arenaMgr.renderSuiteScorecard();
  }
  if (msg.type === 'diag_arena_state') {
    arenaMgr.handleArenaPacket(msg, viaSource);
  }
}
async function pollHttpTunnel(isInitialJoin = false) {
  if (!isInitialJoin && ws?.readyState === 1 && httpOutQueue.length === 0) {
    els.httpStateVal.textContent = 'STANDBY (WSS Open)';
    return;
  }
  if (httpPollingBusy && !isInitialJoin) return;
  httpPollingBusy = true;
  const code = (els.roomInput.value || 'NOVA').trim().toUpperCase();
  const nick = (els.nickInput.value || 'PC').trim().slice(0, 14);
  const batch = httpOutQueue.splice(0, 80);
  const t0 = performance.now();

  try {
    const authQ = roomAuth ? `?auth=${encodeURIComponent(roomAuth)}` : '';
    const hdrs = roomAuth
      ? { 'Content-Type': 'application/json', 'X-Room-Auth': roomAuth }
      : { 'Content-Type': 'application/json' };
    const url = buildApiUrl(endpoints, `/api/http-tunnel${authQ}`);
    const res = await fetch(url, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({
        roomCode: code, clientId, nick, join: isInitialJoin,
        ackSeq: highestSeqSeen, messages: batch
      })
    });
    if (res.ok) {
      const data = await res.json();
      httpTunnelActive = true;
      els.httpStateVal.textContent =
        ws?.readyState === 1 ? 'STANDBY (WSS Open)' : 'OPEN (Active)';
      if (ws?.readyState !== 1) {
        metrics.serverRttMs = Math.max(1, Math.round(performance.now() - t0));
        els.srvRttVal.textContent = `${metrics.serverRttMs} ms (HTTP)`;
      }
      roomCode = data.roomCode || code;
      localPlayerIndex = data.playerIndex || localPlayerIndex;
      syncRoomPeersList(data.peers);
      for (const item of data.accessLog || []) {
        const key = `${item.ts}_${item.note}_${item.ip}`;
        if (!seenAccessEntries.has(key)) {
          seenAccessEntries.add(key);
          logEvent(`[SERVER] ${item.note} from ${item.ip}`, 'info');
        }
      }
      for (const m of data.messages || []) handleIncomingMessage(m, 'http');
    } else els.httpStateVal.textContent = `ERR (${res.status})`;
  } catch {
    httpTunnelActive = false; els.httpStateVal.textContent = 'ERR';
  } finally { httpPollingBusy = false; }
}

async function connectRoom() {
  if (!backendReady) return;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (wsFallbackTimer) clearTimeout(wsFallbackTimer);
  webrtcMgr.closeWebRtc();
  highestSeqSeen = 0; seenSeqSet.clear();
  const code = (els.roomInput.value || 'NOVA').trim().toUpperCase();
  els.roomInput.value = code; roomCode = code;
  roomAuth = await resolveStoredRoomAuth(code);
  els.backToNesLink.href = buildSubPageUrl('./', { room: code }, srv);
  const nick = (els.nickInput.value || 'PC').trim().slice(0, 14);
  ws = new WebSocket(buildWsUrl(endpoints, '/ws'));
  els.wssStateVal.textContent = 'Connecting...';
  els.httpStateVal.textContent = 'STANDBY (Waiting for WSS)';
  wsFallbackTimer = setTimeout(() => {
    if (ws?.readyState !== 1) pollHttpTunnel(true);
  }, 2200);
  ws.onopen = () => {
    if (wsFallbackTimer) clearTimeout(wsFallbackTimer);
    els.wssStateVal.textContent = 'OPEN';
    els.httpStateVal.textContent = 'STANDBY (WSS Open)';
    logEvent(`Connected to WebSocket Relay (${ws.url}).`, 'ok');
    const j = { type: 'join_room', roomCode: code, clientId, nick, roomAuth };
    ws.send(JSON.stringify(j));
  };
  ws.onmessage = (ev) => {
    try { handleIncomingMessage(JSON.parse(ev.data), 'wss'); } catch {}
  };
  ws.onerror = () => pollHttpTunnel(true);
  ws.onclose = (ev) => {
    wsDropCount++;
    lastWsCloseCode = `${ev.code}${ev.reason ? ' ' + ev.reason : ''}`;
    els.wsCloseLabel.textContent =
      `WS Drops: ${wsDropCount} (Last code: ${lastWsCloseCode})`;
    els.wssStateVal.textContent = `BLOCKED/CLOSED (${ev.code})`;
    els.httpStateVal.textContent = 'OPEN (Active Fallback)';
    updateRoomBanner(); pollHttpTunnel(true);
  };
}
els.connectBtn.addEventListener('click', connectRoom);
els.renegotiateRtcBtn.addEventListener('click', () => {
  if (peerConnected) webrtcMgr.startWebRtc(true);
});
document.querySelectorAll('.xfer-btn').forEach((btn) => {
  btn.addEventListener('click', () => suitesMgr.runDataTransferTest(
    Number(btn.dataset.xferKb), btn.dataset.xferMode,
    els.transferTransportSelect.value
  ));
});
els.startStreamBtn.addEventListener('click', () =>
  suitesMgr.run60HzStreamTest(els.streamTransportSelect.value, 300));
els.runAutoSuiteBtn.addEventListener(
  'click', arenaMgr.runFullAutoDiagnosticSuite
);
els.copyInviteBtn.addEventListener('click', () => {
  const c = (els.roomInput.value || 'NOVA').trim().toUpperCase();
  const base = `${window.location.origin}${window.location.pathname}`;
  navigator.clipboard.writeText(buildSubPageUrl(base, { room: c }, srv));
});
els.copyReportBtn.addEventListener('click', () => {
  const txt = JSON.stringify({ metrics, logHistory }, null, 2);
  navigator.clipboard.writeText(txt);
});
setInterval(() => {
  if (backendReady && (ws?.readyState !== 1 || httpOutQueue.length > 0)) {
    pollHttpTunnel(false);
  }
}, 220);
setInterval(async () => {
  if (!backendReady) return;
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    if (peerConnected) {
      metrics.wssPeer.tx++;
      const p = { type: 'peer_ping', via: 'wss', t: performance.now() };
      webrtcMgr.sendViaTransport('wss', p);
    }
  } else if (peerConnected && httpTunnelActive) {
    metrics.httpPeer.tx++;
    const p = { type: 'peer_ping', via: 'http', t: performance.now() };
    webrtcMgr.sendViaTransport('http', p);
  }
  await webrtcMgr.pollSelectedCandidatePair();
}, 1000);
arenaMgr.startArenaLoop();
verifyDiagBackendOrWarn(
  endpoints, els.roomBadge, els.roomStatusText, 'NetDebug'
).then((ok) => { backendReady = ok; if (ok) connectRoom(); });
