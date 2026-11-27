// GitHub Pages Hybrid Connector (Room+Pass Nostr Discovery, Auto-Heal & P2P)
import {
  deriveUniversalKeys
} from '../../src/nostr_browser_crypto.mjs';
import {
  deriveRoomSecret, deriveRoomAuthToken, normalizeRoomCode
} from '../../src/room_auth.mjs';
import {
  DEFAULT_NOSTR_RELAYS, subscribeEncryptedNostr, createServerlessP2pSocket
} from './serverless_p2p_socket.mjs';
import { probeCandidateUrls } from './route_optimizer.mjs';
import { isLocalHostRuntime } from './rom_fast_transfer.mjs';
import { setConnectionPhase } from './connection_status_ui.mjs';

const PASS_STORAGE_KEY = 'nes_room_password_v1';

export function getActiveRelays(search = globalThis.location?.search || '') {
  const qp = new URLSearchParams(search);
  const custom = qp.get('relays');
  if (custom) {
    return custom.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_NOSTR_RELAYS;
}

export async function discoverHostViaNostr({
  room, password, relays = DEFAULT_NOSTR_RELAYS, waitMs = 2400
}) {
  const secret = deriveRoomSecret(room, password);
  if (!secret) return { mode: 'none', reason: 'Missing room password' };
  const beaconKeys = await deriveUniversalKeys(secret);
  const offerKeys = await deriveUniversalKeys(secret, '_p2p_offer');
  let bestBeacon = null;
  let bestOffer = null;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(tmr);
      stopB(); stopO();
      resolve();
    };
    const tmr = setTimeout(done, waitMs);
    const stopB = subscribeEncryptedNostr(relays, beaconKeys, (p) => {
      if (Array.isArray(p?.candidates) && p.candidates.length > 0) {
        if (!bestBeacon || (p.ts || 0) > (bestBeacon.ts || 0)) {
          bestBeacon = p;
          if (Date.now() - (p.ts || 0) < 3600000) setTimeout(done, 600);
        }
      }
    });
    const stopO = subscribeEncryptedNostr(relays, offerKeys, (p) => {
      if (p?.type === 'p2p_offer' && p.sdp &&
          Date.now() - (p.ts || 0) < 300000) {
        if (!bestOffer || (p.ts || 0) > (bestOffer.ts || 0)) {
          bestOffer = p;
        }
      }
    });
  });

  if (bestBeacon?.candidates?.length) {
    const probed = await probeCandidateUrls(
      bestBeacon.candidates.map((c) => ({
        candId: c.id || c.url, routeId: c.id || 'host',
        label: c.label || 'Host', url: c.url
      })), 3, 2500
    );
    const live = probed
      .filter((r) => r.okCount > 0 && Number.isFinite(r.medRttMs))
      .sort((a, b) => a.medRttMs - b.medRttMs);
    if (live.length > 0) {
      return {
        mode: 'pinggy', winner: live[0], scored: live,
        authRequired: Boolean(bestBeacon.authRequired)
      };
    }
  }
  if (bestOffer?.sdp) return { mode: 'p2p', offer: bestOffer };
  return { mode: 'none', reason: 'No online host found' };
}

export function setupHybridConnectionUi(state, ui, hooks) {
  let passInput = document.getElementById('roomPassInput');
  if (!passInput && ui.roomInput) {
    passInput = document.createElement('input');
    passInput.id = 'roomPassInput';
    passInput.type = 'password';
    passInput.placeholder = 'Pass';
    passInput.maxLength = 40;
    passInput.style.width = '70px';
    passInput.title = 'Optional Room Password (for GitHub Pages / P2P Auth)';
    ui.roomInput.insertAdjacentElement('afterend', passInput);
  }

  const qp = new URLSearchParams(window.location.search);
  const initPass = qp.get('pass') ||
    localStorage.getItem(PASS_STORAGE_KEY) || '';
  if (passInput && initPass) passInput.value = initPass;
  const relays = getActiveRelays();
  const forceStatic = qp.get('p2p') === '1' || qp.get('static') === '1';
  let isStaticOrigin = forceStatic;
  state.isStaticOrigin = isStaticOrigin;
  let reconnectTimer = null;
  let connectGen = 0;

  async function refreshRoomAuth() {
    const room = normalizeRoomCode(ui.roomInput?.value || 'NOVA');
    const pass = (passInput?.value || '').trim();
    try {
      if (pass) localStorage.setItem(PASS_STORAGE_KEY, pass);
      else localStorage.removeItem(PASS_STORAGE_KEY);
    } catch {}
    state.roomPassword = pass;
    state.roomAuth = await deriveRoomAuthToken(room, pass);
    return { room, pass, auth: state.roomAuth };
  }

  async function syncHostPasswordToServer() {
    if (isStaticOrigin || state.isExternalServer || !isLocalHostRuntime()) {
      return;
    }
    const { room, pass } = await refreshRoomAuth();
    try {
      await fetch('./api/rendezvous-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, password: pass })
      });
    } catch {}
  }

  passInput?.addEventListener('change', () => {
    refreshRoomAuth().then(() => syncHostPasswordToServer());
  });
  ui.roomInput?.addEventListener('change', () => {
    if (passInput?.value) syncHostPasswordToServer();
  });

  function maybeAddHostP2pButton() {
    if (document.getElementById('hostP2pBtn') || !ui.connectBtn) return;
    if (!isStaticOrigin && qp.get('p2p') !== '1') return;
    const btn = document.createElement('button');
    btn.id = 'hostP2pBtn'; btn.textContent = 'Host P2P';
    btn.title = 'Host serverless browser-to-browser P2P room (no .bat needed)';
    btn.addEventListener('click', () => startServerlessHost());
    ui.connectBtn.insertAdjacentElement('afterend', btn);
  }
  if (isStaticOrigin) maybeAddHostP2pButton();

  const finishBackendCheck = (isStatic) => {
    isStaticOrigin = state.isStaticOrigin = isStatic;
    maybeAddHostP2pButton();
    return isStatic;
  };
  const backendCheckPromise = (
    !state.apiBaseUrl && !forceStatic && typeof fetch === 'function'
  )
    ? fetch('./api/health', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => finishBackendCheck(!Boolean(d?.ok)))
        .catch(() => finishBackendCheck(true))
    : Promise.resolve(isStaticOrigin);

  async function startServerlessHost() {
    cancelAutoReconnect();
    reconnectAttempts = 0;
    const myGen = ++connectGen;
    const { room, pass } = await refreshRoomAuth();
    if (myGen !== connectGen) return;
    if (pass.length < 4) {
      setConnectionPhase(state, ui, {
        phase: 'error', pill: 'PASS NEEDED',
        headline: 'Enter a Room Password (4+ chars) to Host P2P',
        nextStep: 'Type a shared Pass next to Room, then click Host P2P.'
      });
      return ui.showScreenBanner(
        'ENTER A ROOM PASSWORD (4+ CHARS) FOR P2P HOST', 'warn', 3500
      );
    }
    const nick = (ui.nickInput?.value || 'Host').trim().slice(0, 14);
    setConnectionPhase(state, ui, {
      phase: 'hosting_p2p', room, relayCount: 0,
      headline: `Starting P2P Host for "${room}"...`
    });
    ui.showScreenBanner(`HOSTING P2P ROOM "${room}"...`, 'warn', 0);
    const p2pSock = createServerlessP2pSocket({
      role: 'host', roomCode: room, password: pass, nick, relays,
      onStatus: (s, phase, meta) => {
        ui.logDebug(`[P2P] ${s}`);
        if (phase === 'hosting') {
          setConnectionPhase(state, ui, {
            phase: 'hosting_p2p', room, relayCount: meta?.relayCount || 1,
            headline: s
          });
          ui.showScreenBanner(s.toUpperCase(), 'ok', 4500);
        } else if (phase === 'answering') {
          setConnectionPhase(state, ui, {
            phase: 'connecting', headline: s,
            nextStep: 'Completing direct WebRTC handshake...'
          });
        } else if (phase === 'error') {
          setConnectionPhase(state, ui, {
            phase: 'error', pill: 'P2P ERROR', headline: s,
            nextStep: 'Click Host P2P to retry or run PLAY_NES_AUTO.bat.'
          });
          ui.showScreenBanner(s.toUpperCase(), 'err', 4500);
        } else if (phase !== 'connected') {
          ui.showScreenBanner(s.toUpperCase(), 'warn', 4500);
        }
      }
    });
    hooks.attachCustomSocket(p2pSock, room, nick);
  }

  async function smartConnect({ isAutoReconnect = false } = {}) {
    cancelAutoReconnect();
    if (!isAutoReconnect) reconnectAttempts = 0;
    const myGen = ++connectGen;
    await backendCheckPromise;
    if (myGen !== connectGen) return;
    const { room, pass } = await refreshRoomAuth();
    if (myGen !== connectGen) return;
    if (!isStaticOrigin || state.apiBaseUrl) {
      if (!state.isExternalServer && isLocalHostRuntime() && pass) {
        await syncHostPasswordToServer();
      }
      if (myGen !== connectGen) return;
      setConnectionPhase(state, ui, {
        phase: 'connecting', headline: `Connecting to Room "${room}"...`,
        nextStep: 'Opening WebSocket channel...'
      });
      return hooks.connectStandardWs();
    }
    if (pass.length < 4) {
      setConnectionPhase(state, ui, {
        phase: 'error', pill: 'PASS NEEDED',
        headline: 'Enter Room Password (4+ chars) to find Host',
        nextStep: 'Type the exact Pass your Host used, then click Connect.'
      });
      return ui.showScreenBanner(
        'ENTER ROOM PASSWORD TO AUTO-FIND HOST (OR USE ?server=)', 'warn', 4000
      );
    }
    ui.dbgWssState.textContent = 'Discovering Host...';
    setConnectionPhase(state, ui, {
      phase: 'discovering',
      headline: `Step 1/2: Finding Host for "${room}" via Nostr relays...`,
      nextStep: 'Checking live Pinggy relay & Serverless P2P offers...'
    });
    ui.showScreenBanner(
      `FINDING HOST FOR "${room}" VIA P2P RELAYS...`, 'warn', 0
    );
    const found = await discoverHostViaNostr({ room, password: pass, relays });
    if (myGen !== connectGen) return;
    if (found.mode === 'pinggy') {
      const base = found.winner.url.replace(/\/+$/, '');
      state.apiBaseUrl = base;
      state.wsBaseUrl = base.replace(/^http/i, 'ws');
      state.isExternalServer = true;
      state.usedNostrDiscovery = true;
      ui.logDebug(
        `Discovered Host via Nostr -> ${found.winner.label} ` +
          `(${found.winner.medRttMs}ms)`
      );
      setConnectionPhase(state, ui, {
        phase: 'connecting',
        headline: `Step 2/2: Connecting to ${found.winner.label} ` +
          `(${found.winner.medRttMs}ms)...`,
        nextStep: 'Joining room over Pinggy WSS...'
      });
      ui.showScreenBanner(
        `HOST FOUND (${found.winner.medRttMs}ms) - CONNECTING...`, 'ok', 2600
      );
      hooks.onServerDiscovered?.();
      return hooks.connectStandardWs();
    }
    if (found.mode === 'p2p') {
      const nick = (ui.nickInput?.value || 'Guest').trim().slice(0, 14);
      setConnectionPhase(state, ui, {
        phase: 'connecting',
        headline: `Step 2/2: Opening Direct WebRTC P2P to "${room}"...`,
        nextStep: 'Exchanging ICE candidates (3-6 sec)...'
      });
      ui.showScreenBanner('CONNECTING SERVERLESS WEB-RTC P2P...', 'warn', 6000);
      const p2pSock = createServerlessP2pSocket({
        role: 'guest', roomCode: room, password: pass, nick, relays,
        existingOffer: found.offer,
        onStatus: (s, phase) => {
          ui.logDebug(`[P2P] ${s}`);
          if (phase === 'error') {
            setConnectionPhase(state, ui, {
              phase: 'error', pill: 'P2P FAILED', headline: s,
              nextStep: 'Try clicking Retry, or Host can run PLAY_NES_AUTO.bat.'
            });
          }
        }
      });
      return hooks.attachCustomSocket(p2pSock, room, nick);
    }
    ui.dbgWssState.textContent = 'Host Offline';
    setConnectionPhase(state, ui, {
      phase: 'error', pill: 'HOST OFFLINE',
      headline: `No online Host found for Room "${room}"`,
      nextStep: 'Ask Host to click Host P2P (or run PLAY_NES_AUTO.bat) ' +
        'with the same Room + Pass, then click Retry.'
    });
    ui.showScreenBanner(
      'HOST NOT ONLINE YET — START HOST OR CLICK HOST P2P', 'warn', 4500
    );
  }

  let reconnectAttempts = 0;
  function cancelAutoReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }
  function resetReconnectAttempts() { reconnectAttempts = 0; }
  function schedulePinggyAutoReconnect() {
    if (!state.usedNostrDiscovery || reconnectTimer) return;
    if (reconnectAttempts >= 6) {
      return setConnectionPhase(state, ui, {
        phase: 'error', pill: 'HOST OFFLINE',
        headline: 'Auto-reconnect paused after 6 attempts.',
        nextStep: 'Ask Host to restart, then click Retry.'
      });
    }
    const factor = Math.pow(1.4, reconnectAttempts++);
    const delayMs = Math.min(12000, Math.round(2200 * factor));
    ui.showScreenBanner(
      `TUNNEL ROTATED — RECONNECTING (${reconnectAttempts}/6)...`, 'warn', 4000
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      state.apiBaseUrl = state.wsBaseUrl = '';
      smartConnect({ isAutoReconnect: true });
    }, delayMs);
  }
  Promise.all([backendCheckPromise, refreshRoomAuth()]).then(([, { pass }]) => {
    if (!isStaticOrigin && pass && isLocalHostRuntime() &&
        !state.isExternalServer) syncHostPasswordToServer();
  });
  return {
    smartConnect, startServerlessHost, refreshRoomAuth, cancelAutoReconnect,
    resetReconnectAttempts, schedulePinggyAutoReconnect,
    whenReady: () => backendCheckPromise, getPasswordInput: () => passInput
  };
}
