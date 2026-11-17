// Host-Side SSH Tunnel Prober, Auto-Route Selector & Live Route Switcher
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

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

const URL_RE = new RegExp(
  'https://[a-zA-Z0-9.-]+\\.' +
  '(?:lhr\\.life|pinggy-free\\.link|free\\.pinggy\\.net|' +
  'pinggy\\.link|pinggy\\.online)',
  'g'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isLocalHostRequest(req) {
  const ip = String(req.socket?.remoteAddress || '');
  const isLoop =
    ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLoop || req.headers['x-forwarded-for']) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(
    String(req.headers.host || '')
  );
}

function defaultProbeTcp(host, port = 443, timeoutMs = 1300) {
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

function ensurePinggyKey(logsDir) {
  fs.mkdirSync(logsDir, { recursive: true });
  const keyPath = path.join(logsDir, 'pinggy_ed25519');
  if (!fs.existsSync(keyPath)) {
    execFileSync(
      'ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-q', '-N', '']
    );
  }
  return keyPath;
}

async function defaultSpawnSshTunnel(route, localPort, logsDir, onDrop) {
  const args = route.tunnel === 'pinggy'
    ? [
      '-T', '-p', '443', '-i', ensurePinggyKey(logsDir),
      '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=15', '-o', 'IPQoS=lowdelay',
      `-R0:127.0.0.1:${localPort}`, route.host
    ]
    : [
      '-T', '-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=15',
      '-o', 'IPQoS=lowdelay', '-R', `80:127.0.0.1:${localPort}`,
      'nokey@localhost.run'
    ];

  const outPath = path.join(logsDir, 'tunnel_stdout.log');
  const errPath = path.join(logsDir, 'tunnel_stderr.log');
  fs.mkdirSync(logsDir, { recursive: true });
  try { fs.writeFileSync(outPath, ''); fs.writeFileSync(errPath, ''); } catch {}

  const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', killedByUs = false;
  proc.stdout.on('data', (c) => {
    const s = String(c); buf += s;
    try { fs.appendFileSync(outPath, s); } catch {}
  });
  proc.stderr.on('data', (c) => {
    const s = String(c); buf += s;
    try { fs.appendFileSync(errPath, s); } catch {}
  });
  proc.once('exit', () => { if (!killedByUs) onDrop?.(); });

  const kill = () => {
    killedByUs = true;
    try { proc.kill(); } catch {}
  };

  let waitedSecond = false;
  for (let i = 0; i < 42; i++) {
    if (proc.exitCode !== null) break;
    await sleep(320);
    const found = [...new Set(buf.match(URL_RE) || [])];
    if (found.length >= 1) {
      if (route.tunnel === 'pinggy' && found.length < 2 && !waitedSecond) {
        waitedSecond = true;
        await sleep(450);
        continue;
      }
      const pref = found.find((u) => u.includes(route.preferDomain));
      const publicUrl = pref || found[0];
      const altUrl = found.find((u) => u !== publicUrl) || null;
      return { publicUrl, altUrl, kill };
    }
  }
  kill();
  throw new Error(`Tunnel ${route.id} (${route.host}) timed out`);
}

export function createTunnelManager(
  rootDir, tunnelInfo, getLocalPort, options = {}
) {
  const logsDir = options.logsDir || path.join(rootDir, 'logs');
  const probeTcp = options.probeTcpFn || defaultProbeTcp;
  const customSpawn = options.spawnTunnelFn || null;
  let activeHandle = null, stopped = false, switchSeq = 0;
  let lastProbes = {};

  async function probeAllRoutes() {
    const cands = TUNNEL_ROUTES.filter((r) => r.autoCandidate);
    const entries = await Promise.all(
      cands.map(async (r) => [r.id, await probeTcp(r.host, 443)])
    );
    lastProbes = Object.fromEntries(entries);
    const ranked = cands
      .filter((r) => typeof lastProbes[r.id] === 'number')
      .sort((a, b) =>
        (lastProbes[a.id] + a.penaltyMs) - (lastProbes[b.id] + b.penaltyMs)
      );
    return { probes: lastProbes, ranked };
  }

  function stopActive() {
    if (activeHandle) {
      try { activeHandle.kill?.(); } catch {}
      activeHandle = null;
    }
  }

  async function activateRoute(requestedId = 'auto') {
    const mySeq = ++switchSeq;
    tunnelInfo.switching = true;
    stopActive();

    let tryList = [];
    if (requestedId === 'auto') {
      const { ranked } = await probeAllRoutes();
      tryList = ranked.length > 0
        ? ranked : TUNNEL_ROUTES.filter((r) => r.autoCandidate);
    } else {
      const found = TUNNEL_ROUTES.find(
        (r) => r.id === requestedId && !r.isAuto
      );
      if (!found) throw new Error(`Unknown route: ${requestedId}`);
      if (found.tunnel === 'pinggy') {
        lastProbes[found.id] = await probeTcp(found.host, 443);
      }
      tryList = [found];
    }

    let lastErr = null;
    for (const route of tryList) {
      if (mySeq !== switchSeq || stopped) break;
      try {
        const port = getLocalPort();
        const onDrop = () => {
          if (!stopped && mySeq === switchSeq) {
            setTimeout(() => {
              if (!stopped && mySeq === switchSeq) activateRoute(requestedId);
            }, 1500);
          }
        };
        const h = customSpawn
          ? await customSpawn(route, port, logsDir, onDrop)
          : await defaultSpawnSshTunnel(route, port, logsDir, onDrop);
        if (mySeq !== switchSeq || stopped) { h.kill?.(); break; }
        activeHandle = h;
        Object.assign(tunnelInfo, {
          tunnel: route.tunnel,
          region: `${route.region} [${route.host}]`,
          routeId: route.id,
          requestedRouteId: requestedId,
          routeLabel: route.label,
          rttMs: lastProbes[route.id] ?? null,
          publicUrl: h.publicUrl,
          altUrl: h.altUrl || null,
          probes: { ...lastProbes },
          switching: false,
          updatedAt: new Date().toISOString()
        });
        return tunnelInfo;
      } catch (e) {
        lastErr = e;
      }
    }
    tunnelInfo.switching = false;
    throw lastErr || new Error('All tunnel routes failed');
  }

  function formatRoutesPayload() {
    return {
      ok: true,
      routes: TUNNEL_ROUTES.map(({ id, label, isAuto, host, region }) => ({
        id, label, isAuto: Boolean(isAuto), host: host || null,
        region: region || null, rttMs: lastProbes[id] ?? null
      })),
      probes: lastProbes,
      tunnelInfo
    };
  }

  function handleTunnelApi(req, urlObj, res, readJsonBody, sendJson) {
    if (urlObj.pathname === '/api/tunnel-info') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, tunnelInfo }, true);
      }
      if (req.method === 'POST') {
        readJsonBody(req, res, 64 * 1024, (p) => {
          if (p.tunnel) tunnelInfo.tunnel = String(p.tunnel);
          if (p.region) tunnelInfo.region = String(p.region);
          if (p.publicUrl !== undefined) tunnelInfo.publicUrl = p.publicUrl;
          tunnelInfo.updatedAt = new Date().toISOString();
          sendJson(res, 200, { ok: true, tunnelInfo });
        });
        return;
      }
      return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }
    if (!isLocalHostRequest(req)) {
      return sendJson(res, 403, { ok: false, error: 'Host-only API' }, true);
    }
    if (req.method === 'GET') {
      const p = urlObj.searchParams.get('probe') === '1'
        ? probeAllRoutes() : Promise.resolve();
      p.then(() => sendJson(res, 200, formatRoutesPayload(), true))
        .catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req, res, 16 * 1024, (body) => {
        activateRoute(String(body.route || 'auto').trim())
          .then(() => sendJson(res, 200, formatRoutesPayload(), true))
          .catch((e) => sendJson(res, 502, { ok: false, error: e.message }));
      });
      return;
    }
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  return {
    activateRoute, probeAllRoutes, handleTunnelApi,
    stop: () => { stopped = true; switchSeq++; stopActive(); }
  };
}
