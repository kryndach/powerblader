// Host-Side SSH Tunnel Prober, Auto-Route Selector & Live Route Switcher
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  TUNNEL_ROUTES, isLocalHostRequest, defaultProbeTcp, createCandidatePool
} from './tunnel_candidates.mjs';

export { TUNNEL_ROUTES, isLocalHostRequest };

const URL_RE = new RegExp(
  'https://[a-zA-Z0-9.-]+\\.' +
  '(?:lhr\\.life|pinggy-free\\.link|free\\.pinggy\\.net|' +
  'pinggy\\.link|pinggy\\.online)',
  'g'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function resolveSshBin(name = 'ssh') {
  if (process.platform === 'win32') {
    const winRoot = process.env.SystemRoot || 'C:\\Windows';
    const candidates = [
      path.join(winRoot, 'Sysnative', 'OpenSSH', `${name}.exe`),
      path.join(winRoot, 'System32', 'OpenSSH', `${name}.exe`),
      path.join('C:\\Program Files\\Git\\usr\\bin', `${name}.exe`)
    ];
    const hit = candidates.find((p) => fs.existsSync(p));
    if (hit) return hit;
  }
  return name;
}

function ensurePinggyKey(logsDir) {
  fs.mkdirSync(logsDir, { recursive: true });
  const keyPath = path.join(logsDir, 'pinggy_ed25519');
  if (!fs.existsSync(keyPath)) {
    execFileSync(
      resolveSshBin('ssh-keygen'),
      ['-t', 'ed25519', '-f', keyPath, '-q', '-N', '']
    );
  }
  return keyPath;
}

async function defaultSpawnSshTunnel(
  route, localPort, logsDir, onDrop, sshBinOpt = null
) {
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

  const sshCmd = sshBinOpt || resolveSshBin('ssh');
  let buf = '', killedByUs = false, spawnErr = null, ready = false;
  const proc = spawn(sshCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.on('error', (err) => { spawnErr = err; });
  proc.stdout.on('data', (c) => {
    const s = String(c); buf += s;
    try { fs.appendFileSync(outPath, s); } catch {}
  });
  proc.stderr.on('data', (c) => {
    const s = String(c); buf += s;
    try { fs.appendFileSync(errPath, s); } catch {}
  });
  proc.once('exit', () => {
    if (ready && !killedByUs && !spawnErr) onDrop?.();
  });

  const kill = () => {
    killedByUs = true;
    try { proc.kill(); } catch {}
  };

  let waitedSecond = false;
  for (let i = 0; i < 42; i++) {
    if (spawnErr) break;
    if (proc.exitCode !== null) break;
    await sleep(320);
    if (spawnErr) break;
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
      ready = true;
      return { publicUrl, altUrl, kill };
    }
  }
  kill();
  if (spawnErr) throw spawnErr;
  throw new Error(`Tunnel ${route.id} (${route.host}) timed out`);
}

export function createTunnelManager(
  rootDir, tunnelInfo, getLocalPort, options = {}
) {
  const logsDir = options.logsDir || path.join(rootDir, 'logs');
  const probeTcp = options.probeTcpFn || defaultProbeTcp;
  const customSpawn = options.spawnTunnelFn || null;
  let activeHandle = null, activeRouteObj = null, stopped = false;
  let switchSeq = 0, lastProbes = {};

  function applyActiveTunnel(route, handle, reqId) {
    activeRouteObj = route;
    activeHandle = handle;
    Object.assign(tunnelInfo, {
      tunnel: route.tunnel,
      region: `${route.region} [${route.host}]`,
      routeId: route.id,
      requestedRouteId: reqId || tunnelInfo.requestedRouteId || route.id,
      routeLabel: route.label,
      rttMs: lastProbes[route.id] ?? null,
      publicUrl: handle.publicUrl,
      altUrl: handle.altUrl || null,
      probes: { ...lastProbes },
      switching: false,
      updatedAt: new Date().toISOString()
    });
    options.onTunnelChanged?.(tunnelInfo);
  }

  function spawnRouteHandle(route, onDrop = null) {
    const port = getLocalPort();
    return customSpawn
      ? customSpawn(route, port, logsDir, onDrop)
      : defaultSpawnSshTunnel(
        route, port, logsDir, onDrop, options.sshBin || null
      );
  }

  const candidatePool = createCandidatePool({
    getActive: () => ({ route: activeRouteObj, handle: activeHandle }),
    setActive: (route, handle) => {
      applyActiveTunnel(route, handle, tunnelInfo.requestedRouteId || 'auto');
    },
    spawnRoute: (route) => spawnRouteHandle(route, null),
    getProbes: () => lastProbes,
    routes: TUNNEL_ROUTES,
    graceMs: options.candidateGraceMs,
    ttlMs: options.candidateTtlMs
  });

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
    candidatePool.cleanupAll();
    if (activeHandle) {
      try { activeHandle.kill?.(); } catch {}
      activeHandle = null;
      activeRouteObj = null;
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
        let established = false;
        const onDrop = () => {
          if (established && !stopped && mySeq === switchSeq) {
            setTimeout(() => {
              if (!stopped && mySeq === switchSeq) activateRoute(requestedId);
            }, 1500);
          }
        };
        const h = await spawnRouteHandle(route, onDrop);
        if (mySeq !== switchSeq || stopped) { h.kill?.(); break; }
        established = true;
        applyActiveTunnel(route, h, requestedId);
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
    if (urlObj.pathname === '/api/tunnel-candidates' && req.method === 'POST') {
      readJsonBody(req, res, 4096, (body) => {
        candidatePool.openPool(Number(body.maxExtra) || 2)
          .then((r) => sendJson(res, r.ok ? 200 : 400, r, true))
          .catch((e) => sendJson(res, 502, { ok: false, error: e.message }));
      });
      return;
    }
    if (urlObj.pathname === '/api/tunnel-promote' && req.method === 'POST') {
      readJsonBody(req, res, 4096, (body) => {
        const r = candidatePool.promote(body.candId);
        sendJson(
          res, r.ok ? 200 : 400, { ...r, ...formatRoutesPayload() }, true
        );
      });
      return;
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
    openCandidatePool: (n) => candidatePool.openPool(n),
    promoteCandidate: (id) => candidatePool.promote(id),
    stop: () => { stopped = true; switchSeq++; stopActive(); }
  };
}
