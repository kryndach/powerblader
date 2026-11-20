// Cross-Origin Server Endpoint Resolver (?server=<url> Fixed-Origin Support)
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
  loc = globalThis.location || { protocol: 'http:', host: 'localhost', origin: 'http://localhost' }
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
