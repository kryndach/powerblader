// Parallel Pinggy Candidate Tunnel Pool, Edge Table & Zero-Drop Promotion
import net from 'net';

const DEFAULT_TTL_MS = 45000;
const DEFAULT_GRACE_MS = 5000;

export const TUNNEL_ROUTES = [
  { id: 'auto', label: 'Auto (Best Ping)', isAuto: true },
  {
    id: 'sg1', label: 'SG-1 (139.162.21)', tunnel: 'pinggy', region: 'ap',
    host: 'lin.ap.1.a.pinggy.click', preferDomain: 'pinggy-free.link',
    autoCandidate: true, penaltyMs: 0
  },
  {
    id: 'sg2', label: 'SG-2 (139.162.14)', tunnel: 'pinggy', region: 'ap',
    host: 'lin.ap.2.a.pinggy.click', preferDomain: 'pinggy-free.link',
    autoCandidate: true, penaltyMs: 0
  },
  {
    id: 'sg3', label: 'SG-3 (139.162.8)', tunnel: 'pinggy', region: 'ap',
    host: 'lin.ap.3.a.pinggy.click', preferDomain: 'pinggy-free.link',
    autoCandidate: true, penaltyMs: 0
  },
  {
    id: 'sg4_alt', label: 'SG-4 (.pinggy.net)', tunnel: 'pinggy', region: 'ap',
    host: 'lin.ap.4.a.pinggy.click', preferDomain: 'free.pinggy.net',
    autoCandidate: true, penaltyMs: 65
  },
  {
    id: 'eu', label: 'Europe (Frankfurt)', tunnel: 'pinggy', region: 'eu',
    host: 'eu.a.pinggy.io', preferDomain: 'pinggy-free.link',
    autoCandidate: true, penaltyMs: 30
  },
  {
    id: 'lhr', label: 'Backup (localhost.run)', tunnel: 'localhost.run',
    region: 'us', host: 'localhost.run', preferDomain: 'lhr.life',
    autoCandidate: false, penaltyMs: 220
  }
];

export function isLocalHostRequest(req) {
  const ip = String(req.socket?.remoteAddress || '');
  const isLoop =
    ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLoop || req.headers['x-forwarded-for']) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(
    String(req.headers.host || '')
  );
}

export function defaultProbeTcp(host, port = 443, timeoutMs = 1300) {
  const once = () => new Promise((resolve) => {
    const t0 = performance.now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(val);
    };
    sock.setTimeout(timeoutMs, () => finish(null));
    sock.once('connect', () =>
      finish(Math.max(1, Math.round(performance.now() - t0)))
    );
    sock.once('error', () => finish(null));
  });
  return Promise.all([once(), once()]).then(([a, b]) =>
    a !== null && b !== null ? Math.min(a, b) : (a ?? b)
  );
}

export function buildCandidateUrlEntries(route, handle, isActive = false) {
  const out = [];
  if (!route || !handle?.publicUrl) return out;
  const hostTag = handle.publicUrl.includes('free.pinggy.net')
    ? '.pinggy.net' : '.pinggy-free.link';
  out.push({
    candId: route.id,
    routeId: route.id,
    label: `${route.label} (${hostTag})`,
    url: handle.publicUrl,
    isAlt: false,
    isActive
  });
  if (handle.altUrl && handle.altUrl !== handle.publicUrl) {
    const altTag = handle.altUrl.includes('free.pinggy.net')
      ? '.pinggy.net' : '.pinggy-free.link';
    out.push({
      candId: `${route.id}__alt`,
      routeId: route.id,
      label: `${route.label} (${altTag})`,
      url: handle.altUrl,
      isAlt: true,
      isActive: false
    });
  }
  return out;
}

export function pickCompetingRoutes(
  allRoutes, activeRouteId, lastProbes = {}, maxExtra = 2
) {
  const cands = allRoutes.filter(
    (r) => r.autoCandidate && r.tunnel === 'pinggy' && r.id !== activeRouteId
  );
  const byProbe = (a, b) =>
    (lastProbes[a.id] ?? 9999) - (lastProbes[b.id] ?? 9999);
  const picked = [];
  const eu = cands.find((r) => r.id === 'eu');
  if (eu && activeRouteId !== 'eu' && picked.length < maxExtra) {
    picked.push(eu);
  }
  const sgOthers = cands
    .filter((r) => r.region === 'ap' && r.id !== 'sg4_alt')
    .sort(byProbe);
  for (const r of sgOthers) {
    if (picked.length >= maxExtra) break;
    picked.push(r);
  }
  for (const r of cands.sort(byProbe)) {
    if (picked.length >= maxExtra) break;
    if (!picked.includes(r)) picked.push(r);
  }
  return picked;
}

export function createCandidatePool({
  getActive, setActive, spawnRoute, getProbes, routes,
  graceMs = DEFAULT_GRACE_MS, ttlMs = DEFAULT_TTL_MS
}) {
  let pool = new Map();
  let ttlTimer = null;
  const graceTimers = new Set();

  function clearTtl() {
    if (ttlTimer) { clearTimeout(ttlTimer); ttlTimer = null; }
  }

  function killMapEntries(map, keepRouteId = null) {
    for (const [rid, entry] of map.entries()) {
      if (rid !== keepRouteId) {
        try { entry.handle?.kill?.(); } catch {}
      }
    }
    map.clear();
  }

  function scheduleGraceKill(handle) {
    if (!handle?.kill) return;
    const t = setTimeout(() => {
      graceTimers.delete(t);
      try { handle.kill(); } catch {}
    }, graceMs);
    t.unref?.();
    graceTimers.add(t);
  }

  async function openPool(maxExtra = 2) {
    clearTtl();
    killMapEntries(pool);
    const active = getActive();
    if (!active?.route || !active?.handle?.publicUrl) {
      return { ok: false, error: 'No active public tunnel' };
    }
    const candidates = buildCandidateUrlEntries(
      active.route, active.handle, true
    );
    const extras = pickCompetingRoutes(
      routes, active.route.id, getProbes(), maxExtra
    );
    const opened = await Promise.all(
      extras.map(async (route) => {
        try {
          const handle = await spawnRoute(route);
          return { route, handle };
        } catch {
          return null;
        }
      })
    );
    for (const item of opened) {
      if (!item?.handle?.publicUrl) continue;
      pool.set(item.route.id, item);
      candidates.push(...buildCandidateUrlEntries(item.route, item.handle));
    }
    ttlTimer = setTimeout(() => {
      ttlTimer = null;
      killMapEntries(pool);
    }, ttlMs);
    ttlTimer.unref?.();
    return {
      ok: true,
      activeCandId: active.route.id,
      candidates
    };
  }

  function promote(winnerCandId) {
    clearTtl();
    const active = getActive();
    if (!active?.route || !active?.handle) {
      killMapEntries(pool);
      return { ok: false, error: 'No active tunnel to promote' };
    }
    const rawId = String(winnerCandId || active.route.id);
    const isAlt = rawId.endsWith('__alt');
    const baseId = isAlt ? rawId.slice(0, -5) : rawId;

    if (baseId === active.route.id) {
      killMapEntries(pool);
      if (isAlt && active.handle.altUrl) {
        const nextH = {
          ...active.handle,
          publicUrl: active.handle.altUrl,
          altUrl: active.handle.publicUrl
        };
        setActive(active.route, nextH, { switched: true });
        return {
          ok: true, switched: true, routeId: active.route.id,
          label: `${active.route.label} (alt)`,
          publicUrl: nextH.publicUrl, altUrl: nextH.altUrl
        };
      }
      return {
        ok: true, switched: false, routeId: active.route.id,
        label: active.route.label,
        publicUrl: active.handle.publicUrl, altUrl: active.handle.altUrl
      };
    }

    const win = pool.get(baseId);
    if (!win) {
      killMapEntries(pool);
      return {
        ok: true, switched: false, routeId: active.route.id,
        label: active.route.label,
        publicUrl: active.handle.publicUrl, altUrl: active.handle.altUrl
      };
    }

    const prevHandle = active.handle;
    killMapEntries(pool, baseId);
    const nextH = isAlt && win.handle.altUrl
      ? {
        ...win.handle,
        publicUrl: win.handle.altUrl,
        altUrl: win.handle.publicUrl
      }
      : win.handle;
    setActive(win.route, nextH, { switched: true });
    scheduleGraceKill(prevHandle);
    return {
      ok: true, switched: true, routeId: win.route.id,
      label: isAlt ? `${win.route.label} (alt)` : win.route.label,
      publicUrl: nextH.publicUrl, altUrl: nextH.altUrl
    };
  }

  function cleanupAll() {
    clearTtl();
    killMapEntries(pool);
    for (const t of graceTimers) clearTimeout(t);
    graceTimers.clear();
  }

  return { openPool, promote, cleanupAll };
}
