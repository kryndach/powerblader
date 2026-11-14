// Console DOM Elements, Lobby Overlay, Status Strip & Debug Telemetry UI
import { INPUT_BITS } from '../../src/netplay_engine.mjs';
import {
  describeTransferStatus, applyTransferToLobby, updateTransferUi
} from './transfer_status_ui.mjs';

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
  'connectBtn', 'copyLinkBtn', 'resetBtn', 'saveSlotSelect', 'quickSaveBtn',
  'quickLoadBtn', 'exportSaveFileBtn', 'importSaveFileBtn', 'saveFileInput',
  'topInputDelaySelect', 'muteBtn', 'volumeSlider',
  'volumeValLabel', 'crtToggleBtn', 'scanlinesOverlay', 'debugToggleBtn',
  'debugDrawer', 'autoBenchLink', 'netBenchLink', 'lobbyOverlay',
  'lobbyRoomBadge', 'lobbySlotP1', 'lobbyP1Name', 'lobbyP1Rom', 'lobbyP1Badge',
  'lobbySlotP2', 'lobbyP2Name', 'lobbyP2Rom', 'lobbyP2Badge', 'lobbyFooterText',
  'lobbyActionsRow', 'startMatchNowBtn', 'sendRomManualBtn', 'statusLed',
  'statusText', 'romBadge', 'roleBadge', 'miniPadP1', 'miniPadP2', 'pingBadge',
  'fpsLabel', 'screenBanner', 'dbgSyncBadge', 'dbgFrame', 'dbgVerifiedFrame',
  'dbgLocalHash', 'dbgRemoteHash', 'dbgDesyncs', 'forceResyncBtn',
  'dbgTransportBadge', 'dbgWssState', 'dbgRtcState', 'dbgRtt', 'dbgPktRate',
  'transportModeSelect', 'inputDelaySelect', 'dbgStepTime', 'dbgRollbacks',
  'dbgRbDepth', 'dbgAdvantage', 'dbgRift', 'copyTelemetryBtn', 'dbgP1Hex',
  'dbgP2Hex', 'simLagSlider', 'simLossSlider', 'dbgSimLabel', 'dbgLog'
];

export function createConsoleUI(state) {
  const el = (id) => document.getElementById(id);
  const canvas = el('nesCanvas');
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(256, 240);
  const imgBuf32 = new Uint32Array(imgData.data.buffer);

  const ui = {
    canvas,
    ctx,
    imgData,
    imgBuf32,
    dbgP1Btns: el('dbgP1Btns').querySelectorAll('.pbtn'),
    dbgP2Btns: el('dbgP2Btns').querySelectorAll('.pbtn')
  };
  for (const id of UI_IDS) ui[id] = el(id);

  let bannerTimer = null;
  let lastMiniPadP1 = -1;
  let lastMiniPadP2 = -1;

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
    if (bannerTimer) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
    ui.screenBanner.textContent = text;
    ui.screenBanner.className = `screen-banner visible ${level}`;
    if (autoHideMs > 0) {
      bannerTimer = setTimeout(() => {
        ui.screenBanner.classList.remove('visible');
      }, autoHideMs);
    }
  };

  ui.logDebug = function (msg) {
    const ts = new Date().toLocaleTimeString();
    const entry = `[${ts}] ${msg}`;
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
    canvas.width = w;
    canvas.height = h;
    ui.imgData = ctx.createImageData(w, h);
    ui.imgBuf32 = new Uint32Array(ui.imgData.data.buffer);
  };

  ui.renderFrameToCanvas = function (fb) {
    const buf = ui.imgBuf32;
    const len = Math.min(buf.length, fb.length);
    for (let i = 0; i < len; i++) {
      buf[i] = 0xff000000 | fb[i];
    }
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

  ui.updateLobbyOverlay = function () {
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

    ui.lobbyP1Name.textContent = `Player 1 ($4016) - ${p1Nick}`;
    ui.lobbyP2Name.textContent = `Player 2 ($4017) - ${p2Nick}`;

    if (p1Crc) {
      ui.lobbySlotP1.className = 'lobby-slot ready';
      ui.lobbyP1Rom.textContent = `[OK] ${p1RomName} [CRC32: ${p1Crc}]`;
      ui.lobbyP1Badge.className = 'badge ok';
      ui.lobbyP1Badge.textContent = 'ROM READY';
    } else {
      ui.lobbySlotP1.className = 'lobby-slot waiting';
      ui.lobbyP1Rom.textContent = 'Waiting for game selection...';
      ui.lobbyP1Badge.className = 'badge warn';
      ui.lobbyP1Badge.textContent = 'SELECT ROM';
    }

    if (!wsOpen) {
      ui.lobbyRoomBadge.className = 'badge warn';
      ui.lobbyRoomBadge.textContent = 'SOLO / OFFLINE';
      ui.lobbySlotP2.className = 'lobby-slot waiting';
      ui.lobbyP2Rom.textContent = 'Click "Connect" above for 2-PC Online Co-op';
      ui.lobbyP2Badge.className = 'badge warn';
      ui.lobbyP2Badge.textContent = 'OFFLINE';
    } else if (!state.peerConnected) {
      ui.lobbyRoomBadge.className = 'badge warn';
      ui.lobbyRoomBadge.textContent = `ROOM "${state.roomCode}" - WAITING P2`;
      ui.lobbySlotP2.className = 'lobby-slot waiting';
      ui.lobbyP2Rom.textContent = 'Waiting for Player 2 to open room link...';
      ui.lobbyP2Badge.className = 'badge warn';
      ui.lobbyP2Badge.textContent = 'WAITING';
    } else if (p2Crc) {
      ui.lobbySlotP2.className = 'lobby-slot ready';
      ui.lobbyP2Rom.textContent = `[OK] ${p2RomName} [CRC32: ${p2Crc}]`;
      ui.lobbyP2Badge.className = 'badge ok';
      ui.lobbyP2Badge.textContent = 'ROM READY';
    } else {
      ui.lobbySlotP2.className = 'lobby-slot waiting';
      ui.lobbyP2Rom.textContent =
        `${state.peerNick} connected - selecting game...`;
      ui.lobbyP2Badge.className = 'badge warn';
      ui.lobbyP2Badge.textContent = 'SELECT ROM';
    }

    if (applyTransferToLobby(state, ui)) return;

    if (!wsOpen) {
      ui.lobbyActionsRow.style.display = 'none';
      if (state.romUint8) {
        ui.lobbyOverlay.classList.add('hidden');
      } else {
        ui.lobbyFooterText.innerHTML =
          'Select any <strong>ROM / .ZIP</strong> using ' +
          '<strong>-- Select Game --</strong> or <strong>Load ROM</strong> ' +
          'above (or drag &amp; drop onto screen).<br/>For 2-PC Online: ' +
          'click <strong>Connect</strong> and select or send the game!';
        ui.lobbyOverlay.classList.remove('hidden');
      }
      return;
    }

    if (!state.peerConnected) {
      ui.lobbyActionsRow.style.display = 'none';
      if (state.romUint8) {
        ui.lobbyOverlay.classList.add('hidden');
      } else {
        ui.lobbyFooterText.innerHTML =
          `Connected to Room <strong>${state.roomCode}</strong>! Click ` +
          '<strong>Copy Link</strong> to invite Player 2, and select your ' +
          '<strong>ROM / .ZIP</strong> above.';
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

    ui.lobbyOverlay.classList.remove('hidden');
    ui.lobbyRoomBadge.className = crcMatched ? 'badge ok' : 'badge warn';
    ui.lobbyRoomBadge.textContent = crcMatched
      ? `ROOM "${state.roomCode}" - ROMS MATCHED`
      : `ROOM "${state.roomCode}" - 2 PLAYERS CONNECTED`;

    if (!state.romCrc32 && !state.partnerRomCrc32) {
      ui.lobbyFooterText.innerHTML =
        'Both players connected! Select a <strong>game</strong> above ' +
        '(or click <strong>Send ROM</strong>) to start at Frame #0.';
      ui.lobbyActionsRow.style.display = 'none';
    } else if (!state.romCrc32 && state.partnerRomCrc32) {
      ui.lobbyFooterText.innerHTML =
        `Partner selected <strong>${state.partnerRomName}</strong> ` +
        `<code>[${state.partnerRomCrc32}]</code>.<br/>Select the same game ` +
        'or ask Partner to click <strong>Send ROM</strong>!';
      ui.lobbyActionsRow.style.display = 'none';
    } else if (state.romCrc32 && !state.partnerRomCrc32) {
      ui.lobbyFooterText.innerHTML =
        `You selected <strong>${state.romName}</strong> ` +
        `<code>[${state.romCrc32}]</code>.<br/>Click ` +
        '<strong>Send ROM to Partner</strong> below (or wait for Partner).';
      ui.lobbyActionsRow.style.display = 'flex';
      ui.startMatchNowBtn.style.display = 'none';
      ui.sendRomManualBtn.style.display = 'inline-flex';
    } else if (!crcMatched) {
      ui.lobbyFooterText.innerHTML =
        '<span style="color:#f87171;font-weight:700;">' +
        'Different games loaded!</span><br/>Select the same game on both PCs ' +
        'or click <strong>Send ROM to Partner</strong> below.';
      ui.lobbyActionsRow.style.display = 'flex';
      ui.startMatchNowBtn.style.display = 'none';
      ui.sendRomManualBtn.style.display = 'inline-flex';
    } else {
      ui.lobbyFooterText.innerHTML =
        `<span style="color:#4ade80;font-weight:700;">Both PCs have ` +
        `"${state.romName}" [${state.romCrc32}]!</span><br/>` +
        'Synchronizing Frame #0 lockstep start...';
      ui.lobbyActionsRow.style.display = 'flex';
      ui.startMatchNowBtn.style.display = 'inline-flex';
      ui.sendRomManualBtn.style.display = 'none';
    }
  };

  ui.updateStatusStrip = function () {
    const portStr = state.localPlayerIndex === 1 ? '$4016' : '$4017';
    ui.roleBadge.textContent = `YOU: P${state.localPlayerIndex} (${portStr})`;
    const shortRom = state.romName
      ? state.romName.replace(/\.(nes|sfc|smc|md|gen|smd|sms|gg|zip)$/i, '')
      : 'No ROM';

    const xferDesc = describeTransferStatus(state, state.transferStatus);
    if (xferDesc) {
      ui.statusLed.className = 'led warn';
      ui.statusText.textContent = `${xferDesc.title} (${xferDesc.meta})`;
      ui.dbgTransportBadge.className = 'badge warn';
      ui.dbgTransportBadge.textContent = xferDesc.badgeText;
      ui.updateLobbyOverlay();
      return;
    }

    if (!state.ws || state.ws.readyState !== 1) {
      ui.statusLed.className = 'led';
      ui.statusText.textContent = state.romUint8
        ? `SOLO MODE - Playing "${shortRom}" on Port 1`
        : 'EMPTY CONSOLE - Select a .NES ROM above or click Connect';
      ui.dbgTransportBadge.className = 'badge warn';
      ui.dbgTransportBadge.textContent = 'OFFLINE';
      ui.updateLobbyOverlay();
      return;
    }

    if (!state.peerConnected) {
      ui.statusLed.className = 'led warn';
      ui.statusText.textContent =
        `ROOM "${state.roomCode}" - Waiting for Player 2... (${shortRom})`;
      ui.dbgTransportBadge.className = 'badge warn';
      ui.dbgTransportBadge.textContent = 'WAITING FOR P2';
    } else if (
      !state.romCrc32 ||
      !state.partnerRomCrc32 ||
      state.partnerRomCrc32 !== state.romCrc32
    ) {
      ui.statusLed.className = 'led warn';
      const pRom = state.partnerRomName || 'Waiting...';
      ui.statusText.textContent =
        `ROOM "${state.roomCode}" - Select same ROM (You: ${shortRom} | ` +
        `${state.peerNick}: ${pRom})`;
      ui.dbgTransportBadge.className = 'badge warn';
      ui.dbgTransportBadge.textContent = 'SELECT ROM';
    } else if (state.engine && state.engine.syncPaused) {
      ui.statusLed.className = 'led warn';
      ui.statusText.textContent =
        `ROOM "${state.roomCode}" - Locking Frame #0 for "${shortRom}"...`;
      ui.dbgTransportBadge.className = 'badge warn';
      ui.dbgTransportBadge.textContent = 'SYNCING';
    } else {
      const usingP2P =
        state.rtcChannel &&
        state.rtcChannel.readyState === 'open' &&
        ui.transportModeSelect.value !== 'wss';
      const via = usingP2P ? 'WebRTC P2P' : 'WSS Relay';
      ui.statusLed.className = 'led ok';
      ui.statusText.textContent =
        `ONLINE SYNCED [${state.roomCode}] - Playing "${shortRom}" (${via})`;
      ui.dbgTransportBadge.className = 'badge ok';
      ui.dbgTransportBadge.textContent = usingP2P ? 'P2P DIRECT' : 'WSS RELAY';
    }
    ui.updateLobbyOverlay();
  };

  return ui;
}
