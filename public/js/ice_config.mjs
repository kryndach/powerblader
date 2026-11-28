// Shared Gameplay STUN + Regional TURN/443 & BYO Custom TURN ICE Builder
const CUSTOM_TURN_STORAGE_KEY = 'nes_custom_turn_v1';

const RELIABLE_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19305' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun.nextcloud.com:443' }
];

const PUBLIC_TURN_443_SERVERS = [
  {
    urls: [
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
      'turns:openrelay.metered.ca:443?transport=tcp',
      'turn:openrelay.metered.ca:80'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

const ICE_URL_RE = new RegExp(
  '^(stuns?|turns?):(\\[[0-9a-f:.]+\\]|[a-z0-9.-]+)' +
  '(?::(\\d{1,5}))?(?:\\?transport=(udp|tcp))?$', 'i'
);
const HOST_OK_RE = new RegExp(
  '^(\\[[0-9a-f:.]+\\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?' +
  '(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$', 'i'
);
const TURN_URL_RE = /^turns?:/i;

function isValidIceUrl(u) {
  const m = ICE_URL_RE.exec(u);
  if (!m) return false;
  const [, scheme, host, portStr, transport] = m;
  if (!HOST_OK_RE.test(host)) return false;
  if (portStr) {
    const p = Number(portStr);
    if (!(p >= 1 && p <= 65535)) return false;
  }
  if (transport && !/^turns?$/i.test(scheme)) return false;
  return true;
}

function sanitizeIceServer(entry) {
  if (!entry || !entry.urls) return null;
  const rawList = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
  const validUrls = rawList
    .map((u) => String(u || '').trim())
    .filter(isValidIceUrl);
  if (!validUrls.length) return null;
  const hasUser = typeof entry.username === 'string' &&
    entry.username.length > 0;
  const hasPass =
    typeof entry.credential === 'string' && entry.credential.length > 0;
  const hasCreds = hasUser && hasPass;
  const filtered = hasCreds
    ? validUrls
    : validUrls.filter((u) => !TURN_URL_RE.test(u));
  if (!filtered.length) return null;
  const out = { urls: filtered.length === 1 ? filtered[0] : filtered };
  if (hasCreds && filtered.some((u) => TURN_URL_RE.test(u))) {
    out.username = entry.username;
    out.credential = entry.credential;
  }
  return out;
}

function parseCustomTurnFromSearch(search) {
  if (!search) return [];
  try {
    const qp = new URLSearchParams(search);
    const raw = (qp.get('turn') || '').trim();
    if (!raw) return [];
    const urls = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!urls.length) return [];
    const entry = {
      urls: urls.length === 1 ? urls[0] : urls,
      username: qp.get('turnUser') || '',
      credential: qp.get('turnPass') || ''
    };
    const clean = sanitizeIceServer(entry);
    return clean ? [clean] : [];
  } catch {
    return [];
  }
}

function parseCustomTurnFromStorage() {
  try {
    const raw = globalThis.localStorage?.getItem(CUSTOM_TURN_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map(sanitizeIceServer).filter(Boolean);
  } catch {
    return [];
  }
}

export function buildGameplayIceServers(options = {}) {
  const includeTurn = options.includeTurn !== false;
  const search = options.search ?? globalThis.location?.search ?? '';
  const custom = [];
  if (Array.isArray(options.customTurn)) {
    custom.push(...options.customTurn.map(sanitizeIceServer).filter(Boolean));
  } else if (options.customTurn?.urls) {
    const c = sanitizeIceServer(options.customTurn);
    if (c) custom.push(c);
  }
  custom.push(...parseCustomTurnFromSearch(search));
  custom.push(...parseCustomTurnFromStorage());

  const servers = [...custom, ...RELIABLE_STUN_SERVERS];
  if (includeTurn) servers.push(...PUBLIC_TURN_443_SERVERS);
  return servers;
}

export function classifyIceCandidateType(candType = '') {
  const t = String(candType || '').toLowerCase();
  if (t === 'relay') return 'turn_443';
  return 'direct_p2p';
}

export function waitForRtcGathering(rtc, maxWaitMs = 1200) {
  if (!rtc || rtc.iceGatheringState === 'complete' ||
      typeof rtc.addEventListener !== 'function') {
    return Promise.resolve();
  }
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

export async function inspectSelectedIcePair(rtc) {
  if (!rtc?.getStats) return null;
  const stats = await rtc.getStats();
  let pair = null;
  stats.forEach((r) => {
    if (
      r.type === 'candidate-pair' && (r.selected || r.state === 'succeeded')
    ) {
      if (!pair || r.selected) pair = r;
    }
  });
  if (!pair) return null;
  const loc = stats.get(pair.localCandidateId);
  const rem = stats.get(pair.remoteCandidateId);
  const proto = String(loc?.protocol || rem?.protocol || 'udp').toUpperCase();
  const locType = loc?.candidateType || 'direct';
  const isRelay = locType === 'relay' || rem?.candidateType === 'relay';
  const pathKind = classifyIceCandidateType(isRelay ? 'relay' : locType);
  const label = isRelay && locType !== 'relay' ? `${locType}->relay` : locType;
  return { proto, locType, isRelay, pathKind, label };
}
