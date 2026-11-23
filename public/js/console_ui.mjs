// Console DOM Elements, Lobby Overlay, Status Strip & Debug Telemetry UI
import { INPUT_BITS } from '../../src/netplay_engine.mjs';
import {
  describeTransferStatus, applyTransferToLobby, updateTransferUi
} from './transfer_status_ui.mjs';
import {
  getActiveTransportLabel, applyTopButtonStates, applyStripVisuals,
  renderOfflineOrSignalingState
} from './connection_status_ui.mjs';

function formatMaskShort(mask) {
  if (!mask) return 'Idle';
  const parts = [];
  if (mask & INPUT_BITS.UP) parts.push('U');
  if (mask & INPUT_BITS.DOWN) parts.push('D');
  if (mask & INPUT_BITS.LEFT) parts.push('L');
  if (mask & INPUT_BITS.RIGHT) parts.push('R');
  if (mask & INPUT_BITS.SELECT) parts.push('SEL');
  if (mask & INPUT_BITS.START) parts.push('STA');
  if (mask & INPUT_BITS.B) parts.push('B');
  if (mask & INPUT_BITS.A) parts.push('A');
  return parts.join('+');
}

const UI_IDS = [
  'localRomSelect', 'romFileInput', 'topSendRomBtn', 'nickInput', 'roomInput',
  'connectBtn', 'tunnelRouteSelect', 'copyLinkBtn', 'resetBtn',
  'saveSlotSelect', 'quickSaveBtn', 'quickLoadBtn', 'exportSaveFileBtn',
  'importSaveFileBtn', 'saveFileInput', 'topInputDelaySelect', 'muteBtn',
  'volumeSlider', 'volumeValLabel', 'crtToggleBtn', 'scanlinesOverlay',
  'debugToggleBtn', 'debugDrawer', 'autoBenchLink', 'netBenchLink',
  'lobbyOverlay', 'lobbyRoomBadge', 'lobbySlotP1', 'lobbyP1Name', 'lobbyP1Rom',
  'lobbyP1Badge', 'lobbySlotP2', 'lobbyP2Name', 'lobbyP2Rom', 'lobbyP2Badge',
  'lobbyFooterText', 'lobbyActionsRow', 'startMatchNowBtn', 'sendRomManualBtn',
  'statusLed', 'statusText', 'romBadge', 'roleBadge', 'miniPadP1', 'miniPadP2',
  'pingBadge', 'fpsLabel', 'screenBanner', 'dbgSyncBadge', 'dbgFrame',
  'dbgVerifiedFrame', 'dbgLocalHash', 'dbgRemoteHash', 'dbgDesyncs',
  'forceResyncBtn', 'dbgTransportBadge', 'dbgWssState', 'dbgRtcState', 'dbgRtt',
  'dbgPktRate', 'transportModeSelect', 'inputDelaySelect', 'dbgStepTime',
  'dbgRollbacks', 'dbgRbDepth', 'dbgAdvantage', 'dbgRift', 'copyTelemetryBtn',
  'dbgP1Hex', 'dbgP2Hex', 'simLagSlider', 'simLossSlider', 'dbgSimLabel',
  'dbgLog'
];
export function createConsoleUI(state) {
  const el = (id) => document.getElementById(id);
  const canvas = el('nesCanvas');
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(256, 240);
  const imgBuf32 = new Uint32Array(imgData.data.buffer);

  const ui = {
    canvas, ctx, imgData, imgBuf32,
    dbgP1Btns: el('dbgP1Btns').querySelectorAll('.pbtn'),
    dbgP2Btns: el('dbgP2Btns').querySelectorAll('.pbtn')
  };
  for (const id of UI_IDS) ui[id] = el(id);
  let bannerTimer = null, lastMiniPadP1 = -1, lastMiniPadP2 = -1;
  ui.setTransferStatus = (xfer) => updateTransferUi(state, ui, xfer);

  ui.resetSendRomButtons = function () {
    state.transferStatus = null;
    if (ui.sendRomManualBtn) {
      ui.sendRomManualBtn.textContent = 'Send ROM to Partner';
      ui.sendRomManualBtn.disabled = false;
    }
    if (ui.topSendRomBtn) {
      ui.topSendRomBtn.textContent = 'Send ROM';
      ui.topSendRomBtn.disabled = false;
    }
  };
  ui.showScreenBanner = function (text, level = 'ok', autoHideMs = 3500) {
    if (!ui.screenBanner) return;
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    ui.screenBanner.textContent = text;
    ui.screenBanner.className = `screen-banner visible ${level}`;
    if (autoHideMs > 0) {
      bannerTimer = setTimeout(() => {
        ui.screenBanner.classList.remove('visible');
      }, autoHideMs);
    }
  };
  ui.logDebug = function (msg) {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    state.telemetryEvents.push(entry);
    if (state.telemetryEvents.length > 35) state.telemetryEvents.shift();
    const line = document.createElement('div');
    line.textContent = entry;
    ui.dbgLog.prepend(line);
    while (ui.dbgLog.children.length > 60) {
      ui.dbgLog.removeChild(ui.dbgLog.lastChild);
    }
  };
  ui.setConsoleResolution = function (w = 256, h = 240) {
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w; canvas.height = h;
    ui.imgData = ctx.createImageData(w, h);
    ui.imgBuf32 = new Uint32Array(ui.imgData.data.buffer);
  };
  ui.renderFrameToCanvas = function (fb) {
    const buf = ui.imgBuf32;
    const len = Math.min(buf.length, fb.length);
    for (let i = 0; i < len; i++) buf[i] = 0xff000000 | fb[i];
    state.canvasDirty = true;
    if (document.hidden) {
      ctx.putImageData(ui.imgData, 0, 0);
      state.canvasDirty = false;
    }
  };

  ui.updateMiniPads = function (p1Mask, p2Mask) {
    if (ui.miniPadP1 && p1Mask !== lastMiniPadP1) {
      lastMiniPadP1 = p1Mask;
      ui.miniPadP1.textContent = `P1: ${formatMaskShort(p1Mask)}`;
      ui.miniPadP1.classList.toggle('active', p1Mask !== 0);
    }
    if (ui.miniPadP2 && p2Mask !== lastMiniPadP2) {
      lastMiniPadP2 = p2Mask;
      ui.miniPadP2.textContent = `P2: ${formatMaskShort(p2Mask)}`;
      ui.miniPadP2.classList.toggle('active', p2Mask !== 0);
    }
  };

  ui.updateLobbyOverlay = function (offlineGuide = null) {
    if (!ui.lobbyOverlay) return;
    const wsOpen = Boolean(state.ws && state.ws.readyState === 1);
    const myNick = (ui.nickInput.value || 'You').trim();
    const p1IsMe = state.localPlayerIndex === 1;

    const p1Nick = p1IsMe
      ? `${myNick} (YOU)`
      : state.peerConnected ? state.peerNick : 'Waiting for P1...';
    const p2Nick = !p1IsMe
      ? `${myNick} (YOU)`
      : state.peerConnected ? state.peerNick : 'Waiting for P2...';

    const p1RomName = p1IsMe ? state.romName : state.partnerRomName;
    const p1Crc = p1IsMe ? state.romCrc32 : state.partnerRomCrc32;
    const p2RomName = !p1IsMe ? state.romName : state.partnerRomName;
    const p2Crc = !p1IsMe ? state.romCrc32 : state.partnerRomCrc32;

    ui.lobbyP1Name.textContent = `Player 1 - ${p1Nick}`;
    ui.lobbyP2Name.textContent = `Player 2 - ${p2Nick}`;

    if (p1Crc) {
      ui.lobbySlotP1.className = 'lobby-slot ready';
      ui.lobbyP1Rom.textContent = `[OK] ${p1RomName} [CRC32: ${p1Crc}]`;
      ui.lobbyP1Badge.className = 'badge ok';
      ui.lobbyP1Badge.textContent = 'ROM READY';
    } else if (offlineGuide?.p1SlotCls) {
      ui.lobbySlotP1.className = offlineGuide.p1SlotCls;
      ui.lobbyP1Rom.textContent = 'Host ready — you can load a game anytime';
      ui.lobbyP1Badge.className = offlineGuide.p1BadgeCls;
      ui.lobbyP1Badge.textContent = offlineGuide.p1BadgeTxt;
    } else {
      ui.lobbySlotP1.className = 'lobby-slot waiting';
      ui.lobbyP1Rom.textContent = 'Waiting for game selection...';
      ui.lobbyP1Badge.className = 'badge warn';
      ui.lobbyP1Badge.textContent = 'SELECT ROM';
    }

    if (!wsOpen) {
      ui.lobbyRoomBadge.className = offlineGuide?.roomBadgeCls || 'badge warn';
      ui.lobbyRoomBadge.textContent =
        offlineGuide?.roomBadgeTxt || 'SOLO / OFFLINE';
      ui.lobbySlotP2.className = 'lobby-slot waiting';
      ui.lobbyP2Rom.textContent =
        offlineGuide?.p2Rom || 'Click "Connect" above for 2-PC Online Co-op';
      ui.lobbyP2Badge.className = offlineGuide?.p2BadgeCls || 'badge warn';
      ui.lobbyP2Badge.textContent = offlineGuide?.p2BadgeTxt || 'OFFLINE';
    } else if (!state.peerConnected) {
      ui.lobbyRoomBadge.className = 'badge ok';
      ui.lobbyRoomBadge.textContent = `ROOM "${state.roomCode}" - READY FOR P2`;
      ui.lobbySlotP2.className = 'lobby-slot waiting';
      ui.lobbyP2Rom.textContent = 'Waiting for Player 2 to join...';
      ui.lobbyP2Badge.className = 'badge warn';
      ui.lobbyP2Badge.textContent = 'WAITING';
    } else if (p2Crc) {
      ui.lobbySlotP2.className = 'lobby-slot ready';
      ui.lobbyP2Rom.textContent = `[OK] ${p2RomName} [CRC32: ${p2Crc}]`;
      ui.lobbyP2Badge.className = 'badge ok';
      ui.lobbyP2Badge.textContent = 'ROM READY';
    } else {
      ui.lobbySlotP2.className = 'lobby-slot ready';
      ui.lobbyP2Rom.textContent =
        `${state.peerNick} connected — ready for ROM`;
      ui.lobbyP2Badge.className = 'badge ok';
      ui.lobbyP2Badge.textContent = 'CONNECTED';
    }

    if (applyTransferToLobby(state, ui)) return;

    if (!wsOpen) {
      ui.lobbyActionsRow.style.display = 'none';
      if (state.romUint8 && !offlineGuide) {
        ui.lobbyOverlay.classList.add('hidden');
      } else {
        ui.lobbyFooterText.innerHTML = offlineGuide?.footerHtml ||
          'Select any <strong>ROM / .ZIP</strong> above (or drag &amp; ' +
          'drop).<br/>For 2-PC Online: click <strong>Connect</strong> or ' +
          '<strong>Host P2P</strong>!';
        if (!state.romUint8 || offlineGuide?.roomBadgeCls === 'badge err') {
          ui.lobbyOverlay.classList.remove('hidden');
        } else ui.lobbyOverlay.classList.add('hidden');
      }
      return;
    }

    if (!state.peerConnected) {
      ui.lobbyActionsRow.style.display = 'none';
      if (state.romUint8) {
        ui.lobbyOverlay.classList.add('hidden');
      } else {
        const hlth = state.hostHealth?.routeLabel
          ? ` (${state.hostHealth.routeLabel} LIVE)` : '';
        ui.lobbyFooterText.innerHTML =
          `<div class="next-step-box ok"><strong>Room ${state.roomCode}` +
          ` Ready${hlth}!</strong> Tell Partner to click ` +
          '<strong>Connect</strong> (or click <strong>Copy Link</strong>). ' +
          'You can select a game now!</div>';
        ui.lobbyOverlay.classList.remove('hidden');
      }
      return;
    }

    const bothHaveRoms = Boolean(state.romCrc32 && state.partnerRomCrc32);
    const crcMatched = Boolean(
      bothHaveRoms && state.romCrc32 === state.partnerRomCrc32
    );

    if (crcMatched && state.matchStarted) {
      ui.lobbyOverlay.classList.add('hidden');
      return;
    }

    const via = getActiveTransportLabel(state, ui).toUpperCase();
    ui.lobbyOverlay.classList.remove('hidden');
    ui.lobbyRoomBadge.className = 'badge ok';
    ui.lobbyRoomBadge.textContent = crcMatched
      ? `ROOM "${state.roomCode}" [${via}] - MATCHED`
      : `ROOM "${state.roomCode}" CONNECTED [${via}]`;

    if (!state.romCrc32 && !state.partnerRomCrc32) {
      ui.lobbyFooterText.innerHTML =
        '<div class="next-step-box ok"><strong>Connected to ' +
        `${state.peerNick}!</strong> Next step: pick a <strong>ROM</strong> ` +
        'above (or drag &amp; drop) and click <strong>Send ROM</strong>.</div>';
      ui.lobbyActionsRow.style.display = 'none';
    } else if (!state.romCrc32 && state.partnerRomCrc32) {
      ui.lobbyFooterText.innerHTML =
        '<div class="next-step-box ok"><strong>Connected!</strong> Partner ' +
        `loaded <strong>${state.partnerRomName}</strong>. Wait for Partner ` +
        'to click <strong>Send ROM</strong> (or select the same file).</div>';
      ui.lobbyActionsRow.style.display = 'none';
    } else if (state.romCrc32 && !state.partnerRomCrc32) {
      ui.lobbyFooterText.innerHTML =
        '<div class="next-step-box warn"><strong>Connected!</strong> Next ' +
        `step: click <strong>Send ROM to Partner</strong> below to start ` +
        `<strong>${state.romName}</strong>!</div>`;
      ui.lobbyActionsRow.style.display = 'flex';
      ui.startMatchNowBtn.style.display = 'none';
      ui.sendRomManualBtn.style.display = 'inline-flex';
    } else if (!crcMatched) {
      ui.lobbyFooterText.innerHTML =
        '<div class="next-step-box err"><strong>Different games loaded!' +
        '</strong> Click <strong>Send ROM to Partner</strong> to sync both ' +
        'PCs to the same game.</div>';
      ui.lobbyActionsRow.style.display = 'flex';
      ui.startMatchNowBtn.style.display = 'none';
      ui.sendRomManualBtn.style.display = 'inline-flex';
    } else {
      ui.lobbyFooterText.innerHTML =
        `<div class="next-step-box ok"><strong>Both PCs matched ` +
        `"${state.romName}"!</strong> Synchronizing Frame #0...</div>`;
      ui.lobbyActionsRow.style.display = 'flex';
      ui.startMatchNowBtn.style.display = 'inline-flex';
      ui.sendRomManualBtn.style.display = 'none';
    }
  };

  ui.updateStatusStrip = function () {
    ui.roleBadge.textContent = `YOU: P${state.localPlayerIndex}`;
    const shortRom = state.romName
      ? state.romName.replace(/\.(nes|sfc|smc|md|gen|smd|sms|gg|zip)$/i, '')
      : 'No ROM';

    const xferDesc = describeTransferStatus(state, state.transferStatus);
    if (xferDesc) {
      applyStripVisuals(
        ui, 'busy', xferDesc.badgeText, `${xferDesc.title} (${xferDesc.meta})`
      );
      ui.dbgTransportBadge.className = 'badge warn';
      ui.dbgTransportBadge.textContent = xferDesc.badgeText;
      ui.updateLobbyOverlay();
      return;
    }

    if (!state.ws || state.ws.readyState !== 1) {
      const guide = renderOfflineOrSignalingState(state, ui);
      ui.updateLobbyOverlay(guide);
      return;
    }

    const via = getActiveTransportLabel(state, ui);
    if (!state.peerConnected) {
      const hlth = state.hostHealth?.routeLabel
        ? ` (${state.hostHealth.routeLabel})` : '';
      applyStripVisuals(
        ui, 'warn', 'HOST READY',
        `ROOM "${state.roomCode}"${hlth} — Waiting for Partner (${shortRom})`
      );
      applyTopButtonStates(state, ui, 'waiting_p2', 'warn');
      ui.dbgTransportBadge.className = 'badge warn';
      ui.dbgTransportBadge.textContent = 'WAITING P2';
    } else if (
      !state.romCrc32 || !state.partnerRomCrc32 ||
      state.partnerRomCrc32 !== state.romCrc32
    ) {
      const nextHint = state.romCrc32
        ? 'Click Send ROM' : 'Pick a ROM or wait for Send ROM';
      applyStripVisuals(
        ui, 'ok', `${via.toUpperCase()}`,
        `CONNECTED TO ${state.peerNick} [${via}] — Next: ${nextHint}`
      );
      applyTopButtonStates(state, ui, 'connected', 'ok');
      ui.dbgTransportBadge.className = 'badge ok';
      ui.dbgTransportBadge.textContent = via.toUpperCase();
    } else if (state.engine && state.engine.syncPaused) {
      applyStripVisuals(
        ui, 'busy', 'SYNCING',
        `ROOM "${state.roomCode}" — Syncing Frame #0 for "${shortRom}"...`
      );
      applyTopButtonStates(state, ui, 'connected', 'ok');
      ui.dbgTransportBadge.className = 'badge warn';
      ui.dbgTransportBadge.textContent = 'SYNCING';
    } else {
      applyStripVisuals(
        ui, 'ok', `${via.toUpperCase()}`,
        `ONLINE [${state.roomCode}] — Playing "${shortRom}" (${via})`
      );
      applyTopButtonStates(state, ui, 'playing', 'ok');
      ui.dbgTransportBadge.className = 'badge ok';
      ui.dbgTransportBadge.textContent = via.toUpperCase();
    }
    ui.updateLobbyOverlay();
  };

  return ui;
}
