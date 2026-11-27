// 2-Way Peer Route Optimizer (Parallel Edge Probing & Zero-Copy Auto-Redirect)
import { isLocalHostRuntime } from './rom_fast_transfer.mjs';

const DEFAULT_PROBES = 5;
const DEFAULT_TIMEOUT_MS = 3000;
const MIN_GAIN_MS = 15;

export function selectBestMeasuredRoute(
  results, currentCandId, minGainMs = MIN_GAIN_MS
) {
  const scored = (results || [])
    .filter((r) => r && r.okCount >= 2 && Number.isFinite(r.medRttMs))
    .map((r) => ({
      ...r,
      score: Math.round(
        r.medRttMs + (r.jitterMs || 0) * 0.5 + (r.lossCount || 0) * 120
      )
    }))
    .sort((a, b) => a.score - b.score);

  if (scored.length === 0) {
    return {
      shouldSwitch: false, winner: null, current: null, gainMs: 0, scored
    };
  }
  const best = scored[0];
  const cur = scored.find((r) => r.candId === currentCandId) || null;
  if (!cur) {
    return {
      shouldSwitch: true, winner: best, current: null, gainMs: null, scored
    };
  }
  const gainMs = cur.score - best.score;
  const shouldSwitch = best.candId !== cur.candId && gainMs >= minGainMs;
  return {
    shouldSwitch,
    winner: shouldSwitch ? best : cur,
    current: cur,
    gainMs,
    scored
  };
}

async function probeSingleCandidate(cand, probesPerUrl, timeoutMs) {
  const base = String(cand.url || '').replace(/\/+$/, '');
  const times = [];
  let lossCount = 0;
  for (let i = 0; i < probesPerUrl; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(
        `${base}/api/edge-ping?n=${i}&r=${Math.random().toString(36).slice(2)}`,
        { cache: 'no-store', mode: 'cors', signal: ctrl.signal }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.text();
      times.push(Math.max(1, Math.round(performance.now() - t0)));
    } catch {
      lossCount++;
    } finally {
      clearTimeout(timer);
    }
  }
  const measured = times.length >= 2 ? times.slice(1) : times;
  if (measured.length === 0) {
    return {
      candId: cand.candId, routeId: cand.routeId, label: cand.label,
      url: cand.url, okCount: 0, lossCount, medRttMs: null, jitterMs: null
    };
  }
  const sorted = [...measured].sort((a, b) => a - b);
  const medRttMs = sorted[Math.floor(sorted.length / 2)];
  let jitSum = 0;
  for (let i = 1; i < measured.length; i++) {
    jitSum += Math.abs(measured[i] - measured[i - 1]);
  }
  const jitterMs = measured.length > 1
    ? Math.round(jitSum / (measured.length - 1)) : 0;
  return {
    candId: cand.candId, routeId: cand.routeId, label: cand.label,
    url: cand.url, okCount: times.length, lossCount,
    medRttMs, minRttMs: sorted[0], jitterMs
  };
}

export function probeCandidateUrls(
  candidates, probesPerUrl = DEFAULT_PROBES, timeoutMs = DEFAULT_TIMEOUT_MS
) {
  return Promise.all(
    (candidates || []).map((c) =>
      probeSingleCandidate(c, probesPerUrl, timeoutMs)
    )
  );
}

const MIGRATE_PARAMS = [
  'room', 'nick', 'debug', 'pass', 'turn', 'turnUser', 'turnPass', 'relays'
];

export function buildMigratedClientUrl(targetBaseUrl, currentHref) {
  const base = String(targetBaseUrl || '').replace(/\/+$/, '');
  const cur = new URL(currentHref);
  const keepFixed = cur.searchParams.has('server') ||
    cur.searchParams.has('host');
  const next = keepFixed
    ? new URL(cur.origin + cur.pathname)
    : new URL(`${base}/`);
  if (keepFixed) next.searchParams.set('server', base);
  for (const key of MIGRATE_PARAMS) {
    const val = cur.searchParams.get(key);
    if (val) next.searchParams.set(key, val);
  }
  next.searchParams.set('optimized', '1');
  return next.toString();
}

export function createRouteOptimizer(state, ui, tunnelCtrl, hooks = {}) {
  let activeProbe = null;
  let autoTimer = null;
  let hotOptimized = false;

  const isClientOptimized = () => {
    if (hotOptimized) return true;
    try {
      const q = new URLSearchParams(window.location.search);
      return q.get('optimized') === '1';
    } catch {
      return false;
    }
  };

  function clearActiveProbe() {
    if (activeProbe?.timer) clearTimeout(activeProbe.timer);
    activeProbe = null;
  }

  function sendWs(obj) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  async function finalizeProbe(winnerCandId, summaryBanner, isSwitch, meta) {
    try {
      const res = await fetch('/api/tunnel-promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candId: winnerCandId })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        tunnelCtrl?.applyRoutesResponse?.(data);
        if (isSwitch && data.publicUrl) {
          sendWs({
            type: 'route_migrate',
            url: data.publicUrl,
            label: meta?.label || data.label || winnerCandId,
            rttMs: meta?.medRttMs ?? null
          });
          const invite = tunnelCtrl?.buildInviteUrl?.();
          if (invite) {
            try { await navigator.clipboard.writeText(invite); } catch {}
          }
        }
      }
    } catch {}
    if (summaryBanner) ui.showScreenBanner(summaryBanner, 'ok', 4200);
  }

  async function triggerOptimization({ auto = false } = {}) {
    if (state.isExternalServer || !isLocalHostRuntime() || activeProbe) return;
    if (!state.ws || state.ws.readyState !== 1 || !state.peerConnected) {
      if (!auto) {
        ui.showScreenBanner('CONNECT PARTNER TO PROBE ROUTES', 'warn', 2600);
      }
      return;
    }
    if (auto && (state.matchStarted || state.peerRouteOptimized)) return;
    const probeId = `rp_${Date.now().toString(36)}`;
    activeProbe = { probeId, activeCandId: null, timer: null };
    if (!auto) ui.showScreenBanner('OPENING CANDIDATE ROUTES...', 'warn', 0);
    try {
      const res = await fetch('/api/tunnel-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxExtra: 2 })
      });
      const data = await res.json();
      if (!res.ok || !data?.ok || (data.candidates || []).length < 2) {
        clearActiveProbe();
        if (!auto) {
          ui.showScreenBanner(
            data?.error || 'NO PUBLIC TUNNEL TO OPTIMIZE', 'warn', 3200
          );
        }
        return;
      }
      activeProbe.activeCandId = data.activeCandId;
      activeProbe.timer = setTimeout(() => {
        const prev = activeProbe;
        clearActiveProbe();
        if (prev?.activeCandId) finalizeProbe(prev.activeCandId, null, false);
      }, 25000);
      ui.logDebug(
        `Probing partner RTT across ${data.candidates.length} route URLs...`
      );
      ui.showScreenBanner(
        `TESTING ${data.candidates.length} ROUTES FROM PARTNER...`, 'warn', 8000
      );
      sendWs({
        type: 'route_probe_req', probeId, auto,
        activeCandId: data.activeCandId, candidates: data.candidates
      });
    } catch (e) {
      clearActiveProbe();
      if (!auto) {
        ui.showScreenBanner(`ROUTE PROBE FAILED: ${e.message}`, 'err', 3500);
      }
    }
  }

  async function handleRouteMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'route_probe_req') {
      if (msg.auto && isClientOptimized()) {
        sendWs({
          type: 'route_probe_res', probeId: msg.probeId, skipped: true
        });
        return true;
      }
      ui.showScreenBanner('TESTING FASTEST ROUTE TO HOST...', 'warn', 8000);
      const results = await probeCandidateUrls(msg.candidates || []);
      sendWs({ type: 'route_probe_res', probeId: msg.probeId, results });
      return true;
    }
    if (msg.type === 'route_probe_res') {
      if (!activeProbe || msg.probeId !== activeProbe.probeId) return true;
      const curId = activeProbe.activeCandId;
      clearActiveProbe();
      if (msg.skipped) {
        await finalizeProbe(curId, null, false);
        return true;
      }
      const dec = selectBestMeasuredRoute(msg.results, curId, MIN_GAIN_MS);
      const board = (dec.scored || [])
        .map((r) => `${r.label}: ${r.medRttMs}ms (+/-${r.jitterMs}ms)`)
        .join(' | ');
      if (board) ui.logDebug(`2-Way Route Scoreboard: ${board}`);
      const winId = dec.winner?.candId || curId;
      const banner = dec.shouldSwitch
        ? `FASTEST ROUTE: ${dec.winner.label} (${dec.winner.medRttMs}ms)`
        : `ROUTE OPTIMAL (${dec.current?.medRttMs ?? '--'}ms)`;
      await finalizeProbe(winId, banner, dec.shouldSwitch, dec.winner);
      return true;
    }
    if (msg.type === 'route_migrate') {
      const url = String(msg.url || '').replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(url)) return true;
      const msTxt = msg.rttMs ? ` (${msg.rttMs}ms)` : '';
      ui.showScreenBanner(
        `SWITCHING TO FASTER ROUTE: ${msg.label || ''}${msTxt}...`, 'ok', 4000
      );
      const canHotSwitch =
        typeof hooks.onHotRouteSwitch === 'function' &&
        (state.isExternalServer || state.isStaticOrigin);
      if (canHotSwitch) {
        hotOptimized = true;
        state.apiBaseUrl = url;
        state.wsBaseUrl = url.replace(/^http/i, 'ws');
        state.isExternalServer = true;
        try {
          const next = new URL(window.location.href);
          const hasExplicitServer =
            next.searchParams.has('server') || next.searchParams.has('host');
          if (hasExplicitServer && !state.usedNostrDiscovery) {
            next.searchParams.delete('host');
            next.searchParams.set('server', url);
            next.searchParams.set('optimized', '1');
            window.history?.replaceState?.(null, '', next.toString());
          }
        } catch {}
        setTimeout(() => hooks.onHotRouteSwitch(url), 80);
        return true;
      }
      const nextUrl = buildMigratedClientUrl(url, window.location.href);
      setTimeout(() => { window.location.replace(nextUrl); }, 250);
      return true;
    }
    return false;
  }

  function onPeerJoined(peerInfo) {
    state.peerRouteOptimized = Boolean(peerInfo?.routeOptimized);
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    if (state.isExternalServer || !isLocalHostRuntime()) return;
    if (state.localPlayerIndex !== 1 || state.peerRouteOptimized) return;
    autoTimer = setTimeout(() => {
      autoTimer = null;
      triggerOptimization({ auto: true });
    }, 1000);
  }

  return {
    triggerOptimization, handleRouteMessage, onPeerJoined, isClientOptimized
  };
}
