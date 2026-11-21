// Cross-Origin Server Endpoint Resolver (?server=<url> Fixed-Origin Support)
import { deriveRoomAuthToken } from '../../src/room_auth.mjs';

const PASS_STORAGE_KEY = 'nes_room_password_v1';

export function normalizeServerUrl(raw) {
  const s = String(raw || '').trim();
  if (!/^https?:\/\/[^/\s]+/i.test(s)) return '';
  try {
    const u = new URL(s);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function resolveServerEndpoints(
  search = globalThis.location?.search || '',
  loc = globalThis.location || {
    protocol: 'http:', host: 'localhost', origin: 'http://localhost'
  }
) {
  const params = new URLSearchParams(search);
  const raw = params.get('server') || params.get('host') || '';
  const serverBase = normalizeServerUrl(raw);
  if (serverBase) {
    const u = new URL(serverBase);
    const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsBase = `${wsProto}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    return {
      apiBaseUrl: serverBase,
      wsBaseUrl: wsBase,
      isExternalServer: u.origin !== loc.origin
    };
  }
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    apiBaseUrl: '',
    wsBaseUrl: `${wsProto}//${loc.host}`,
    isExternalServer: false
  };
}

export function buildApiUrl(state, path) {
  const raw = state?.apiBaseUrl ? String(state.apiBaseUrl) : '';
  return `${raw.replace(/\/+$/, '')}${path}`;
}

export function buildWsUrl(state, path = '/ws') {
  if (state?.wsBaseUrl) {
    return `${String(state.wsBaseUrl).replace(/\/+$/, '')}${path}`;
  }
  const loc = globalThis.location || { protocol: 'http:', host: 'localhost' };
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}${path}`;
}

export function buildSubPageUrl(pageFile, paramsObj = {}, apiBaseUrl = '') {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(paramsObj || {})) {
    if (v !== undefined && v !== null && String(v) !== '') q.set(k, String(v));
  }
  if (apiBaseUrl) q.set('server', apiBaseUrl);
  const qs = q.toString();
  return qs ? `${pageFile}?${qs}` : pageFile;
}

export async function resolveStoredRoomAuth(
  roomCode, search = globalThis.location?.search || ''
) {
  const qp = new URLSearchParams(search);
  let pass = qp.get('pass') || '';
  if (!pass) {
    try { pass = localStorage.getItem(PASS_STORAGE_KEY) || ''; } catch {}
  }
  return pass ? deriveRoomAuthToken(roomCode, pass) : '';
}

export async function checkBackendAvailable(ep) {
  if (typeof fetch !== 'function') return true;
  const url = ep?.apiBaseUrl
    ? buildApiUrl(ep, '/api/health') : './api/health';
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return false;
    const d = await r.json();
    return Boolean(d?.ok);
  } catch {
    return false;
  }
}

export async function verifyDiagBackendOrWarn(ep, badgeEl, textEl, toolName) {
  if (await checkBackendAvailable(ep)) return true;
  if (badgeEl) {
    badgeEl.className = 'badge err';
    badgeEl.textContent = 'SERVER REQUIRED';
  }
  if (textEl) {
    textEl.textContent =
      `${toolName} requires a live Node/Pinggy server (run PLAY_NES_*.bat ` +
      'or open via your Pinggy link). Static GitHub Pages has no /ws backend.';
  }
  return false;
}
