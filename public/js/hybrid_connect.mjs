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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    btn.id = 'hostP2pBtn';
    btn.textContent = 'Host P2P';
    btn.title = 'Host serverless browser-to-browser P2P room (no .bat needed)';
    btn.addEventListener('click', () => startServerlessHost());
    ui.connectBtn.insertAdjacentElement('afterend', btn);
  }
  if (isStaticOrigin) maybeAddHostP2pButton();

  const backendCheckPromise = (
    !state.apiBaseUrl && !forceStatic && typeof fetch === 'function'
  )
    ? fetch('./api/health', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          isStaticOrigin = !Boolean(d?.ok);
          state.isStaticOrigin = isStaticOrigin;
          maybeAddHostP2pButton();
          return isStaticOrigin;
        })
        .catch(() => {
          isStaticOrigin = true;
          state.isStaticOrigin = true;
          maybeAddHostP2pButton();
          return true;
        })
    : Promise.resolve(isStaticOrigin);

  async function startServerlessHost() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const myGen = ++connectGen;
    const { room, pass } = await refreshRoomAuth();
    if (myGen !== connectGen) return;
    if (pass.length < 4) {
      return ui.showScreenBanner(
        'ENTER A ROOM PASSWORD (4+ CHARS) FOR P2P HOST', 'warn', 3500
      );
    }
    const nick = (ui.nickInput?.value || 'Host').trim().slice(0, 14);
    ui.showScreenBanner(`HOSTING P2P ROOM "${room}"...`, 'warn', 0);
    const p2pSock = createServerlessP2pSocket({
      role: 'host', roomCode: room, password: pass, nick, relays,
      onStatus: (s) => {
        ui.logDebug(`[P2P] ${s}`);
        ui.showScreenBanner(s.toUpperCase(), 'warn', 4500);
      }
    });
    hooks.attachCustomSocket(p2pSock, room, nick);
  }

  async function smartConnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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
      return hooks.connectStandardWs();
    }
    if (pass.length < 4) {
      return ui.showScreenBanner(
        'ENTER ROOM PASSWORD TO AUTO-FIND HOST (OR USE ?server=)', 'warn', 4000
      );
    }
    ui.dbgWssState.textContent = 'Discovering Host...';
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
      ui.showScreenBanner(
        `HOST FOUND (${found.winner.medRttMs}ms) - CONNECTING...`, 'ok', 2600
      );
      hooks.onServerDiscovered?.();
      return hooks.connectStandardWs();
    }
    if (found.mode === 'p2p') {
      const nick = (ui.nickInput?.value || 'Bro').trim().slice(0, 14);
      ui.showScreenBanner('CONNECTING SERVERLESS WEB-RTC P2P...', 'warn', 6000);
      const p2pSock = createServerlessP2pSocket({
        role: 'guest', roomCode: room, password: pass, nick, relays,
        existingOffer: found.offer,
        onStatus: (s) => ui.logDebug(`[P2P] ${s}`)
      });
      return hooks.attachCustomSocket(p2pSock, room, nick);
    }
    ui.dbgWssState.textContent = 'Host Offline';
    ui.showScreenBanner(
      'HOST NOT ONLINE YET — START HOST OR CLICK HOST P2P', 'warn', 4500
    );
  }

  function schedulePinggyAutoReconnect() {
    if (!state.usedNostrDiscovery || reconnectTimer) return;
    ui.showScreenBanner(
      'TUNNEL ROTATED — AUTO-RECONNECTING VIA NOSTR...', 'warn', 4000
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      state.apiBaseUrl = '';
      state.wsBaseUrl = '';
      smartConnect();
    }, 2200);
  }

  Promise.all([backendCheckPromise, refreshRoomAuth()]).then(([, { pass }]) => {
    if (!isStaticOrigin && pass && isLocalHostRuntime() &&
        !state.isExternalServer) {
      syncHostPasswordToServer();
    }
  });

  return {
    smartConnect, startServerlessHost, refreshRoomAuth,
    schedulePinggyAutoReconnect, whenReady: () => backendCheckPromise,
    getPasswordInput: () => passInput
  };
}
