// Multi-Path Live 2-Way RTT Racer (Direct P2P vs TURN/443 vs Relay WSS)
const DEFAULT_MIN_GAIN_MS = 12;
const DEFAULT_COOLDOWN_MS = 6000;
const STALE_PATH_MS = 15000;
const MAX_SAMPLES = 8;

function medianOf(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function jitterOf(arr) {
  if (arr.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < arr.length; i++) sum += Math.abs(arr[i] - arr[i - 1]);
  return Math.round(sum / (arr.length - 1));
}

export function scoreTransportPath(p) {
  if (!p || !Number.isFinite(p.rttMs) || p.rttMs <= 0) return Infinity;
  const jit = Number.isFinite(p.jitterMs) ? p.jitterMs : 0;
  const lossPen = (p.lossPct || 0) * 15;
  // Direct UDP avoids TCP head-of-line blocking -> small 5ms preference on ties
  const udpBonus = p.kind === 'direct_p2p' ? -5 : 0;
  return Math.round(p.rttMs + jit * 0.5 + lossPen + udpBonus);
}

export function rankTransportPaths(paths) {
  return (paths || [])
    .filter((p) => p && Number.isFinite(p.rttMs) && p.rttMs > 0)
    .map((p) => ({ ...p, score: scoreTransportPath(p) }))
    .sort((a, b) => a.score - b.score);
}

export function createMultiPathRacer(options = {}) {
  const nowFn = options.now || (() => Date.now());
  const minGainMs = options.minGainMs ?? DEFAULT_MIN_GAIN_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const paths = new Map();
  let activeId = null;
  let lastSwitchAt = 0;

  function recordSample(id, meta = {}) {
    if (!id || !Number.isFinite(meta.rttMs) || meta.rttMs <= 0) return;
    let rec = paths.get(id);
    if (!rec) {
      rec = {
        id,
        kind: meta.kind || 'wss',
        label: meta.label || id,
        samples: [],
        lossPct: 0,
        updatedAt: 0
      };
      paths.set(id, rec);
    }
    if (meta.kind) rec.kind = meta.kind;
    if (meta.label) rec.label = meta.label;
    if (Number.isFinite(meta.lossPct)) rec.lossPct = meta.lossPct;
    rec.samples.push(Math.round(meta.rttMs));
    if (rec.samples.length > MAX_SAMPLES) rec.samples.shift();
    rec.updatedAt = nowFn();
  }

  function setPathMetrics(id, meta = {}) {
    if (!id || !Number.isFinite(meta.rttMs) || meta.rttMs <= 0) return;
    const r = Math.round(meta.rttMs);
    let rec = paths.get(id);
    if (!rec) {
      rec = {
        id, kind: meta.kind || 'wss', label: meta.label || id,
        samples: [r, r], lossPct: 0, updatedAt: 0
      };
      paths.set(id, rec);
    } else {
      if (meta.kind) rec.kind = meta.kind;
      if (meta.label) rec.label = meta.label;
      rec.samples[0] = r;
      rec.samples[1] = r;
      rec.samples.length = 2;
    }
    if (Number.isFinite(meta.lossPct)) rec.lossPct = meta.lossPct;
    rec.updatedAt = nowFn();
  }

  function removePath(id) {
    paths.delete(id);
    if (activeId === id) activeId = null;
  }

  function getLiveCandidates() {
    const now = nowFn();
    const list = [];
    for (const rec of paths.values()) {
      if (now - rec.updatedAt > STALE_PATH_MS) continue;
      if (rec.samples.length === 0) continue;
      const rttMs = medianOf(rec.samples);
      const jitterMs = jitterOf(rec.samples);
      list.push({
        id: rec.id, kind: rec.kind, label: rec.label,
        rttMs, jitterMs, lossPct: rec.lossPct, samples: rec.samples.length
      });
    }
    return rankTransportPaths(list);
  }

  function selectActivePath() {
    const ranked = getLiveCandidates();
    if (!ranked.length) return null;
    const now = nowFn();
    const cur = activeId ? ranked.find((r) => r.id === activeId) : null;
    if (!cur) {
      activeId = ranked[0].id;
      lastSwitchAt = now;
      return ranked[0];
    }
    const best = ranked[0];
    const ready = best.samples >= 2;
    const gain = cur.score - best.score;
    const majorWin = gain >= 30;
    if (
      best.id !== cur.id &&
      ready &&
      gain >= minGainMs &&
      (majorWin || now - lastSwitchAt >= cooldownMs)
    ) {
      activeId = best.id;
      lastSwitchAt = now;
      return best;
    }
    return cur;
  }

  function getScoreboard() {
    const cur = selectActivePath();
    return getLiveCandidates().map((r) => ({
      ...r, active: Boolean(cur && r.id === cur.id)
    }));
  }

  function reset() {
    paths.clear();
    activeId = null;
    lastSwitchAt = 0;
  }

  return {
    recordSample, setPathMetrics, removePath,
    selectActivePath, getScoreboard, reset
  };
}
