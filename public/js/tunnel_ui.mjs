// Host-Side Live Tunnel Route Selector & Public Invite Link Copy Controller
import { isLocalHostRuntime } from './rom_fast_transfer.mjs';

export function setupHostTunnelController(state, ui, hooks = {}) {
  let cachedTunnel = null;
  let routeList = [];

  function buildInviteUrl() {
    const code = (ui.roomInput?.value || 'NOVA').trim().toUpperCase();
    const base = isLocalHostRuntime() && cachedTunnel?.publicUrl
      ? cachedTunnel.publicUrl.replace(/\/+$/, '')
      : window.location.origin;
    return `${base}/?room=${encodeURIComponent(code)}`;
  }

  function applyRoutesResponse(data) {
    if (!data?.ok) return;
    if (Array.isArray(data.routes)) routeList = data.routes;
    if (data.tunnelInfo) cachedTunnel = data.tunnelInfo;
    renderRouteOptions();
  }

  async function refreshTunnelInfo() {
    try {
      const res = await fetch('/api/tunnel-info');
      if (res.ok) {
        const d = await res.json();
        if (d.tunnelInfo) cachedTunnel = d.tunnelInfo;
      }
    } catch {}
    return cachedTunnel;
  }

  function renderRouteOptions() {
    const sel = ui.tunnelRouteSelect;
    if (!sel || routeList.length === 0) return;
    sel.innerHTML = '';
    const activeId = cachedTunnel?.routeId || '';
    const reqId = cachedTunnel?.requestedRouteId || activeId || 'auto';
    for (const r of routeList) {
      const opt = document.createElement('option');
      opt.value = r.id;
      if (r.isAuto) {
        const win = routeList.find((x) => x.id === activeId);
        const tag = reqId === 'auto' && win
          ? ` -> ${win.label.split(' ')[0]}` +
            (win.rttMs ? ` (${win.rttMs}ms)` : '')
          : '';
        opt.textContent = `Route: Auto${tag}`;
      } else {
        const ms = typeof r.rttMs === 'number' ? ` · ${r.rttMs}ms` : '';
        opt.textContent = `Route: ${r.label}${ms}`;
      }
      sel.appendChild(opt);
    }
    if ([...sel.options].some((o) => o.value === reqId)) sel.value = reqId;
  }

  ui.copyLinkBtn?.addEventListener('click', async () => {
    if (isLocalHostRuntime() && !cachedTunnel?.publicUrl) {
      await refreshTunnelInfo();
    }
    const url = buildInviteUrl();
    try {
      await navigator.clipboard.writeText(url);
      const orig = ui.copyLinkBtn.textContent;
      ui.copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => { ui.copyLinkBtn.textContent = orig; }, 1500);
      ui.logDebug(`Copied invite link: ${url}`);
    } catch {}
  });

  const api = { buildInviteUrl, applyRoutesResponse };
  const isHost = !state.isExternalServer && isLocalHostRuntime();
  if (!isHost || !ui.tunnelRouteSelect) return api;

  ui.tunnelRouteSelect.style.display = '';
  const deckGroup = ui.tunnelRouteSelect.parentElement;
  if (deckGroup && !document.getElementById('optimizeRouteBtn')) {
    const optBtn = document.createElement('button');
    optBtn.id = 'optimizeRouteBtn';
    optBtn.textContent = 'Best Route';
    optBtn.title = 'Probe partner ping across Pinggy edges & auto-switch';
    optBtn.addEventListener('click', () => hooks.onOptimizeRoute?.());
    const joinBtn = document.createElement('button');
    joinBtn.id = 'exportJoinFileBtn';
    joinBtn.textContent = 'Join File';
    joinBtn.title = 'Download permanent join_nes.html bookmark for partner';
    joinBtn.addEventListener('click', () => {
      const code = (ui.roomInput?.value || 'NOVA').trim().toUpperCase();
      window.location.href = `/api/join-file?room=${encodeURIComponent(code)}`;
    });
    ui.tunnelRouteSelect.insertAdjacentElement('afterend', joinBtn);
    ui.tunnelRouteSelect.insertAdjacentElement('afterend', optBtn);
  }

  fetch('/api/tunnel-routes')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => applyRoutesResponse(data))
    .catch(() => {});

  ui.tunnelRouteSelect.addEventListener('change', async () => {
    const chosen = ui.tunnelRouteSelect.value || 'auto';
    ui.tunnelRouteSelect.disabled = true;
    ui.showScreenBanner(
      `SWITCHING TUNNEL TO "${chosen.toUpperCase()}"...`, 'warn', 0
    );
    try {
      const res = await fetch('/api/tunnel-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: chosen })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      applyRoutesResponse(data);
      const inviteUrl = buildInviteUrl();
      let copied = false;
      try {
        await navigator.clipboard.writeText(inviteUrl);
        copied = true;
      } catch {}
      const rttStr = cachedTunnel?.rttMs ? ` (${cachedTunnel.rttMs}ms)` : '';
      const lbl = cachedTunnel?.routeLabel || chosen;
      ui.logDebug(
        `Switched route -> ${lbl}${rttStr}: ${inviteUrl}` +
          (cachedTunnel?.altUrl ? ` (Alt: ${cachedTunnel.altUrl})` : '')
      );
      ui.showScreenBanner(
        `TUNNEL READY [${lbl}${rttStr}]` +
          (copied ? ' - LINK COPIED!' : ' - CLICK COPY LINK'),
        'ok', 4200
      );
    } catch (e) {
      ui.logDebug(`Tunnel switch failed: ${e.message}`);
      ui.showScreenBanner(`TUNNEL ERROR: ${e.message}`, 'err', 4500);
    } finally {
      ui.tunnelRouteSelect.disabled = false;
    }
  });

  return api;
}
