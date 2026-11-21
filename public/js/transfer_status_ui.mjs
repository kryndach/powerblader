// Unified ROM Upload, Download & Core-Boot Progress UI Controller
const escHtml = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function formatTransferProgress(info = {}) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(info.pct) || 0)));
  const loaded = Number(info.loadedBytes) || 0;
  const total = Number(info.totalBytes) || 0;
  const bps = Number(info.bps) || 0;
  if (total <= 0) return `${pct}%`;
  const kbTot = Math.max(1, Math.round(total / 1024));
  const sizeStr = total >= 1048576
    ? `${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
    : `${Math.round(loaded / 1024)} / ${kbTot} KB`;
  const rateStr = bps >= 1048576
    ? ` - ${(bps / 1048576).toFixed(1)} MB/s`
    : bps >= 1024 ? ` - ${Math.round(bps / 1024)} KB/s` : '';
  return `${sizeStr} (${pct}%)${rateStr}`;
}

export function describeTransferStatus(state, xfer) {
  if (!xfer) return null;
  const pct = Math.max(0, Math.min(100, Math.round(Number(xfer.pct) || 0)));
  const peer = state.peerNick || 'Partner';
  const name = xfer.romName || state.romName || 'ROM';
  const meta = xfer.detail || `${pct}%`;

  if (xfer.phase === 'uploading') {
    return {
      pct, meta, badgeTarget: 'me', badgeText: `UPLOAD ${pct}%`,
      topBtn: `Uploading ${pct}%`, lobbyBtn: `Uploading ROM (${pct}%)...`,
      title: `Uploading "${name}" to Relay`
    };
  }
  if (xfer.phase === 'sending') {
    return {
      pct, meta, badgeTarget: 'peer', badgeText: `DL ${pct}%`,
      topBtn: `Sending ${pct}%`, lobbyBtn: `Sending to ${peer} (${pct}%)...`,
      title: `Sending "${name}" to ${peer}`
    };
  }
  if (xfer.phase === 'partner-core') {
    return {
      pct, meta, badgeTarget: 'peer', badgeText: `STARTING ${pct}%`,
      topBtn: 'Starting...', lobbyBtn: `${peer} Starting (${pct}%)...`,
      title: `${peer} is starting "${name}"`
    };
  }
  if (xfer.phase === 'downloading') {
    return {
      pct, meta, badgeTarget: 'me', badgeText: `DL ${pct}%`,
      topBtn: `Receiving ${pct}%`, lobbyBtn: `Downloading ROM (${pct}%)...`,
      title: `Downloading "${name}" from ${peer}`
    };
  }
  if (xfer.phase === 'loading-core') {
    return {
      pct, meta, badgeTarget: 'me', badgeText: `ENGINE ${pct}%`,
      topBtn: `Engine ${pct}%`, lobbyBtn: `Loading Engine (${pct}%)...`,
      title: `Loading Emulator Engine for "${name}"`
    };
  }
  return {
    pct, meta, badgeTarget: 'me', badgeText: `LOAD ${pct}%`,
    topBtn: `Loading ${pct}%`, lobbyBtn: `Loading ROM (${pct}%)...`,
    title: `Loading "${name}"`
  };
}

export function applyTransferToLobby(state, ui) {
  const desc = describeTransferStatus(state, state.transferStatus);
  if (!desc) return false;
  const p1IsMe = state.localPlayerIndex === 1;
  const targetP1 = (desc.badgeTarget === 'me') === p1IsMe;
  const badgeEl = targetP1 ? ui.lobbyP1Badge : ui.lobbyP2Badge;
  const slotEl = targetP1 ? ui.lobbySlotP1 : ui.lobbySlotP2;
  if (badgeEl) {
    badgeEl.className = 'badge warn';
    badgeEl.textContent = desc.badgeText;
  }
  if (slotEl) slotEl.className = 'lobby-slot waiting';

  if (!state.matchStarted && ui.lobbyOverlay) {
    ui.lobbyOverlay.classList.remove('hidden');
    ui.lobbyRoomBadge.className = 'badge warn';
    ui.lobbyRoomBadge.textContent = state.peerConnected
      ? `ROOM "${state.roomCode}" - SYNCING ROM`
      : 'LOADING CARTRIDGE';
    ui.lobbyFooterText.innerHTML =
      '<div class="xfer-box">' +
        `<div class="xfer-title">${escHtml(desc.title)}</div>` +
        '<div class="xfer-bar">' +
          `<div class="xfer-fill" style="width:${desc.pct}%"></div>` +
        '</div>' +
        `<div class="xfer-meta">${escHtml(desc.meta)}</div>` +
      '</div>';
    if (state.peerConnected) {
      ui.lobbyActionsRow.style.display = 'flex';
      ui.startMatchNowBtn.style.display = 'none';
      ui.sendRomManualBtn.style.display = 'inline-flex';
    }
  }
  return true;
}

const SEND_PHASE_RANK = { uploading: 1, sending: 2, 'partner-core': 3 };
const RECV_PHASE_RANK = { downloading: 1, 'loading-core': 2 };

export function updateTransferUi(state, ui, xfer) {
  if (!xfer) {
    state.transferStatus = null;
    if (ui.sendRomManualBtn) {
      ui.sendRomManualBtn.textContent = 'Send ROM to Partner';
      ui.sendRomManualBtn.disabled = false;
    }
    if (ui.topSendRomBtn) {
      ui.topSendRomBtn.textContent = 'Send ROM';
      ui.topSendRomBtn.disabled = false;
    }
    ui.updateStatusStrip();
    return;
  }
  const prev = state.transferStatus;
  let nextXfer = { ...xfer };
  if (prev && prev.romName === nextXfer.romName &&
      (!prev.sessionId || !nextXfer.sessionId ||
        prev.sessionId === nextXfer.sessionId)) {
    const sPrev = SEND_PHASE_RANK[prev.phase] || 0;
    const sNext = SEND_PHASE_RANK[nextXfer.phase] || 0;
    const rPrev = RECV_PHASE_RANK[prev.phase] || 0;
    const rNext = RECV_PHASE_RANK[nextXfer.phase] || 0;
    if ((sPrev && sNext && sNext < sPrev) ||
        (rPrev && rNext && rNext < rPrev)) {
      return;
    }
    if (prev.phase === nextXfer.phase &&
        Number(nextXfer.pct) < Number(prev.pct)) {
      nextXfer.pct = prev.pct;
      if (prev.detail) nextXfer.detail = prev.detail;
    }
  }
  state.transferStatus = nextXfer;
  const desc = describeTransferStatus(state, nextXfer);
  if (ui.topSendRomBtn) {
    ui.topSendRomBtn.textContent = desc.topBtn;
    ui.topSendRomBtn.disabled = true;
  }
  if (ui.sendRomManualBtn) {
    ui.sendRomManualBtn.textContent = desc.lobbyBtn;
    ui.sendRomManualBtn.disabled = true;
  }
  ui.showScreenBanner(`${desc.title} - ${desc.meta}`, 'warn', 0);
  ui.updateStatusStrip();
}

export function bindRomDropAndPicker(state, ui, romSync, unpackRomIfNeeded) {
  const dz = document.getElementById('dropTarget');
  async function loadFile(file) {
    if (!file) return;
    try {
      const detail = formatTransferProgress({
        pct: 0, loadedBytes: 0, totalBytes: file.size || 0
      });
      ui.setTransferStatus?.({
        phase: 'local-load', romName: file.name, pct: 0, detail
      });
      const rawU8 = new Uint8Array(await file.arrayBuffer());
      const { romName, romUint8, serverCachedCrc } = await unpackRomIfNeeded(
        rawU8, file.name, state.roomCode
      );
      state.localServerRomKey = null;
      await romSync.loadRomFromUint8(romUint8, romName, {
        broadcastToPeer: true, isAutoDefault: false, serverCachedCrc
      });
    } catch (err) {
      ui.resetSendRomButtons?.();
      ui.logDebug(`Archive/ROM load error: ${err.message}`);
      ui.showScreenBanner(`LOAD FAILED: ${err.message}`, 'err', 4000);
      ui.updateStatusStrip();
    }
  }
  ui.romFileInput?.addEventListener('change', (e) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (f) loadFile(f);
  });
  let d = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); d = Math.max(0, d) + 1; dz?.classList.add('drag-over');
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault(); if (--d <= 0) dz?.classList.remove('drag-over');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); d = 0; dz?.classList.remove('drag-over');
    if (e.dataTransfer?.files?.[0]) loadFile(e.dataTransfer.files[0]);
  });
}
