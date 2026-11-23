// Color-Coded Connection State Pill, Button Styling, Host Health & Lobby Guide
const BTN_STATES = [
  'btn-state-busy', 'btn-state-host', 'btn-state-ok', 'btn-state-err'
];
const STRIP_STATES = ['strip-busy', 'strip-warn', 'strip-ok', 'strip-err'];

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function getActiveTransportLabel(state, ui) {
  if (state.ws?.isServerlessP2p) return 'P2P Direct';
  const rtcOpen = state.rtcChannel?.readyState === 'open' &&
    ui?.transportModeSelect?.value !== 'wss';
  if (rtcOpen) return 'WebRTC P2P';
  if (state.usedNostrDiscovery || state.isExternalServer) return 'Pinggy WSS';
  return 'WSS Relay';
}

export function setConnectionPhase(state, ui, patch) {
  state.connStatus = {
    phase: 'offline', tone: 'idle', pill: 'OFFLINE',
    headline: '', nextStep: '', ...(state.connStatus || {}), ...patch
  };
  ui?.updateStatusStrip?.();
}

export function ensureConnStatePill(ui) {
  if (ui.connStatePill) return ui.connStatePill;
  if (!ui.statusLed || typeof document === 'undefined') return null;
  let pill = document.getElementById('connStatePill');
  if (!pill) {
    pill = document.createElement('span');
    pill.id = 'connStatePill';
    pill.className = 'conn-pill idle';
    pill.textContent = 'OFFLINE';
    ui.statusLed.insertAdjacentElement('afterend', pill);
  }
  ui.connStatePill = pill;
  return pill;
}

export function applyTopButtonStates(state, ui, phase, tone) {
  const hostBtn = document.getElementById('hostP2pBtn');
  const connBtn = ui.connectBtn;
  const setCls = (el, cls) => {
    if (!el) return;
    el.classList.remove(...BTN_STATES);
    if (cls) el.classList.add(cls);
  };
  if (connBtn) {
    if (phase === 'discovering' || phase === 'connecting') {
      connBtn.textContent = phase === 'discovering'
        ? 'Finding...' : 'Connecting...';
      setCls(connBtn, 'btn-state-busy');
    } else if (phase === 'connected' || phase === 'playing') {
      connBtn.textContent = 'Connected';
      setCls(connBtn, 'btn-state-ok');
    } else if (phase === 'waiting_p2' && !state.ws?.isServerlessP2p) {
      connBtn.textContent = 'Room Ready';
      setCls(connBtn, 'btn-state-host');
    } else if (tone === 'err') {
      connBtn.textContent = 'Retry';
      setCls(connBtn, 'btn-state-err');
    } else {
      const open = state.ws?.readyState === 1;
      connBtn.textContent = open ? 'Reconnect' : 'Connect';
      setCls(connBtn, null);
    }
  }
  if (hostBtn) {
    if (phase === 'hosting_p2p') {
      const okN = state.connStatus?.relayCount || 0;
      hostBtn.textContent = okN > 0 ? `Hosting (${okN} OK)` : 'Hosting P2P...';
      setCls(hostBtn, okN > 0 ? 'btn-state-host' : 'btn-state-busy');
    } else if ((phase === 'connected' || phase === 'playing') &&
               state.ws?.isServerlessP2p) {
      hostBtn.textContent = 'P2P Live';
      setCls(hostBtn, 'btn-state-ok');
    } else {
      hostBtn.textContent = 'Host P2P';
      setCls(hostBtn, null);
    }
  }
}

export function applyStripVisuals(ui, tone, pillText, statusMsg) {
  const pill = ensureConnStatePill(ui);
  if (ui.statusLed) {
    ui.statusLed.className = tone === 'idle' ? 'led' : `led ${tone}`;
  }
  if (pill) {
    pill.className = `conn-pill ${tone}`;
    pill.textContent = pillText;
  }
  const strip = ui.statusLed?.closest?.('.status-strip');
  if (strip) {
    strip.classList.remove(...STRIP_STATES);
    if (tone !== 'idle') strip.classList.add(`strip-${tone}`);
  }
  if (ui.statusText && statusMsg) ui.statusText.textContent = statusMsg;
}

export function renderOfflineOrSignalingState(state, ui) {
  const cs = state.connStatus || {};
  const ph = cs.phase || 'offline';
  const hostHlth = state.hostHealth;
  if (ph === 'hosting_p2p') {
    const okN = cs.relayCount || 0;
    const room = cs.room || ui.roomInput?.value || 'NOVA';
    const tone = okN > 0 ? 'warn' : 'busy';
    const pill = okN > 0 ? `HOSTING P2P (${okN})` : 'STARTING P2P';
    const msg = okN > 0
      ? `HOSTING P2P "${room}" (${okN} relays OK) — Waiting for Partner`
      : cs.headline || `Starting P2P Host for "${room}"...`;
    applyStripVisuals(ui, tone, pill, msg);
    applyTopButtonStates(state, ui, ph, tone);
    ui.dbgTransportBadge.className = okN > 0 ? 'badge ok' : 'badge warn';
    ui.dbgTransportBadge.textContent = 'HOSTING P2P';
    return {
      roomBadgeCls: okN > 0 ? 'badge ok' : 'badge warn',
      roomBadgeTxt: okN > 0
        ? `HOSTING P2P "${room}" (${okN} RELAYS OK)`
        : `STARTING P2P HOST "${room}"...`,
      p1SlotCls: 'lobby-slot ready',
      p1BadgeCls: 'badge ok',
      p1BadgeTxt: state.romCrc32 ? 'ROM READY' : 'HOST READY',
      p2BadgeCls: 'badge warn', p2BadgeTxt: 'WAITING',
      p2Rom: `Partner: enter Room "${room}" + Pass and click Connect`,
      footerHtml: '<div class="next-step-box ok"><strong>Host is live!' +
        `</strong> All good on your side (${okN} relays). Load a ROM now or ` +
        'wait for Partner to click <strong>Connect</strong>.</div>'
    };
  }
  if (ph === 'discovering' || ph === 'connecting') {
    const pill = ph === 'discovering' ? 'FINDING HOST' : 'CONNECTING';
    const msg = cs.headline || 'Connecting to Host...';
    applyStripVisuals(ui, 'busy', pill, msg);
    applyTopButtonStates(state, ui, ph, 'busy');
    ui.dbgTransportBadge.className = 'badge warn';
    ui.dbgTransportBadge.textContent = pill;
    return {
      roomBadgeCls: 'badge busy',
      roomBadgeTxt: `${pill}...`,
      p2BadgeCls: 'badge busy', p2BadgeTxt: 'CONNECTING',
      p2Rom: cs.headline || 'Negotiating connection...',
      footerHtml: `<div class="next-step-box busy"><strong>${esc(msg)}` +
        '</strong>' + (cs.nextStep ? `<br/>${esc(cs.nextStep)}` : '') + '</div>'
    };
  }
  if (ph === 'error') {
    const pill = cs.pill || 'ERROR';
    const msg = cs.headline || 'Connection failed';
    applyStripVisuals(ui, 'err', pill, msg);
    applyTopButtonStates(state, ui, 'error', 'err');
    ui.dbgTransportBadge.className = 'badge err';
    ui.dbgTransportBadge.textContent = pill;
    return {
      roomBadgeCls: 'badge err', roomBadgeTxt: pill,
      p2BadgeCls: 'badge err', p2BadgeTxt: 'FAILED',
      p2Rom: msg,
      footerHtml: `<div class="next-step-box err"><strong>${esc(msg)}` +
        `</strong><br/>${esc(cs.nextStep || 'Check Room + Pass & Retry.')}` +
        '</div>'
    };
  }
  if (hostHlth?.publicUrl) {
    const lbl = hostHlth.routeLabel || 'Pinggy';
    const rCnt = hostHlth.okRelays || 0;
    const pill = `HOST READY (${lbl.split(' ')[0]})`;
    const msg = state.romUint8
      ? `HOST READY (${lbl}) — Click Connect to open Room`
      : `HOST READY (${lbl}${rCnt ? `, ${rCnt} relays` : ''}) — Click Connect`;
    applyStripVisuals(ui, 'ok', pill, msg);
    applyTopButtonStates(state, ui, 'offline', 'idle');
    ui.dbgTransportBadge.className = 'badge ok';
    ui.dbgTransportBadge.textContent = 'HOST READY';
    return {
      roomBadgeCls: 'badge ok',
      roomBadgeTxt: `HOST LIVE (${lbl})`,
      p2BadgeCls: 'badge warn', p2BadgeTxt: 'CLICK CONNECT',
      p2Rom: 'Tunnel is live! Click Connect above so Partner can join.',
      footerHtml: '<div class="next-step-box ok"><strong>Host Tunnel Live' +
        ` (${esc(lbl)})!</strong> Next: click <strong>Connect</strong> &amp;` +
        ' pick a game. Partner can join via GitHub Pages + Pass.</div>'
    };
  }
  applyStripVisuals(ui, 'idle', 'OFFLINE', state.romUint8
    ? `SOLO MODE — Playing "${state.romName}" on Port 1`
    : 'OFFLINE — Select a ROM to play solo, or click Connect / Host P2P');
  applyTopButtonStates(state, ui, 'offline', 'idle');
  ui.dbgTransportBadge.className = 'badge warn';
  ui.dbgTransportBadge.textContent = 'OFFLINE';
  return null;
}

export function startLocalHostHealthPoller(state, ui) {
  if (state.isStaticOrigin || state.isExternalServer ||
      typeof fetch !== 'function') return;
  const poll = async () => {
    try {
      const noStore = { cache: 'no-store' };
      const [hRes, rRes] = await Promise.all([
        fetch('./api/health', noStore),
        fetch('./api/rendezvous-info', noStore).catch(() => null)
      ]);
      const h = hRes.ok ? await hRes.json() : null;
      const r = rRes?.ok ? await rRes.json() : null;
      const ti = h?.tunnelInfo || null;
      const pubUrl = ti?.publicUrl ||
        (r?.status?.lastCandidateCount > 0 ? 'live' : '');
      if (pubUrl) {
        state.hostHealth = {
          publicUrl: pubUrl,
          routeLabel: ti?.routeLabel || 'Pinggy',
          okRelays: r?.status?.okRelays?.length || 0,
          hasPassword: Boolean(r?.hasPassword)
        };
        ui.updateStatusStrip();
      }
    } catch {}
  };
  poll();
  setInterval(poll, 12000);
}
