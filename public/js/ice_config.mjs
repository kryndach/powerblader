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
      'turn:openrelay.metered.ca:80'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

function parseCustomTurnFromSearch(search) {
  if (!search) return [];
  try {
    const qp = new URLSearchParams(search);
    const raw = (qp.get('turn') || '').trim();
    if (!raw) return [];
    const urls = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!urls.length) return [];
    const entry = { urls: urls.length === 1 ? urls[0] : urls };
    const u = qp.get('turnUser');
    const p = qp.get('turnPass');
    if (u) entry.username = u;
    if (p) entry.credential = p;
    return [entry];
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
    return list.filter((x) => x && x.urls);
  } catch {
    return [];
  }
}

export function buildGameplayIceServers(options = {}) {
  const includeTurn = options.includeTurn !== false;
  const search = options.search ?? globalThis.location?.search ?? '';
  const custom = [];
  if (Array.isArray(options.customTurn)) custom.push(...options.customTurn);
  else if (options.customTurn?.urls) custom.push(options.customTurn);
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
