// ROM Loader, Local Cartridge Discovery, Lockstep Barrier & Chunked Transfer
import {
  NesNetplayEngine, computeRomCrc32, detectSystemFromRomBytes
} from '../../src/netplay_engine.mjs';
import {
  uint8ToBinaryString, uint8ToBase64, base64ToUint8
} from '../../src/crc32.mjs';
import { createSegaGpgxCore } from '../../src/sega_gpgx_core.mjs';
import { createFbneoArcadeCore } from '../../src/fbneo_arcade_core.mjs';
import { streamRomToPeer } from './rom_archive.mjs';
import {
  isLocalHostRuntime, putCachedRomByCrc, formatTransferProgress,
  fetchRomBytesWithProgress, uploadRomToServerCache
} from './rom_fast_transfer.mjs';
import { buildApiUrl } from './server_endpoint.mjs';

export { base64ToUint8 };
const jsnes = globalThis.window?.jsnes;

export function createRomSyncManager(state, ui, audio) {
  function resolveDesiredInputDelay(sysIdOverride = null) {
    const sel = ui.topInputDelaySelect || ui.inputDelaySelect;
    const val = (sel ? sel.value : '2') || '2';
    const sysId = sysIdOverride || state.engine?.core?.systemId || 'nes';
    if (val === 'auto') {
      const clump = state.engine ? state.engine.rxClumpFrames : 0;
      const rec = NesNetplayEngine.computeRecommendedInputDelay(
        state.rttMs, state.jitterMs, clump
      );
      if (sysId === 'arcade' && state.peerConnected) {
        if (state.engine?.shadowRollback?.isReady?.()) {
          return Math.min(2, Math.max(1, rec));
        }
        return Math.max(state.rttMs >= 160 ? 4 : 3, rec);
      }
      return rec;
    }
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : 2;
  }

  function ensureRomInDropdown(name, u8) {
    if (!name) return;
    if (u8) state.customRomsMap.set(name, u8);
    let existing = Array.from(ui.localRomSelect.options)
      .find((o) => o.value === name);
    if (!existing) {
      existing = document.createElement('option');
      existing.value = name; existing.textContent = name;
      ui.localRomSelect.appendChild(existing);
    }
    ui.localRomSelect.value = name;
  }

  function armSyncAckWatchdog(sessionId, timeoutMs = 45000) {
    if (state.syncAckTimeout) clearTimeout(state.syncAckTimeout);
    state.syncAckTimeout = setTimeout(() => {
      if (state.engine?.syncPaused && state.engine.sessionId === sessionId) {
        state.engine.syncPaused = false;
        state.matchStarted = true;
        ui.resetSendRomButtons?.();
        ui.logDebug('Sync ACK timeout elapsed; unpausing emulation.');
        ui.updateStatusStrip();
      }
    }, timeoutMs);
  }

  function startLockstepMatchAtFrameZero(
    reason = 'ROM CRC32 Match', force = false
  ) {
    if (!state.ws || state.ws.readyState !== 1 || !state.peerConnected ||
        !state.romUint8 || !state.romBinaryString || !state.engine) return;
    if (!force && state.syncAckTimeout) return;
    state.activeRomAbortCtrl?.abort();
    state.activeRomAbortCtrl = null; state.activeRomDownload = null;
    state.incomingRomTransfer = null; state.sendingRomSessionId = null;
    ui.resetSendRomButtons?.();

    const rand = Math.random().toString(36).slice(2, 7);
    const newSessionId = `${Date.now().toString(36)}_${rand}`;
    state.nes.loadROM(state.romBinaryString);
    state.engine.localPlayer = state.localPlayerIndex;
    state.engine.online = true;
    state.engine.enableRiftPacing = false;
    state.engine.inputDelayFrames = resolveDesiredInputDelay();
    state.engine.resetTimeline(0, newSessionId);
    state.engine.syncPaused = true;
    if (state.partnerRomCrc32 !== state.romCrc32) state.matchStarted = false;
    armSyncAckWatchdog(newSessionId, 12000);

    const oc = state.nesOverclockMode ?? (state.nesOverclockEnabled ? 1 : 0);
    state.ws.send(JSON.stringify({
      type: 'match_start_req', sessionId: newSessionId,
      romCrc32: state.romCrc32, romName: state.romName,
      inputDelayFrames: state.engine.inputDelayFrames,
      overclockEnabled: oc > 0, overclockMode: oc, reason
    }));
    ui.logDebug(
      `Initiated Frame #0 lockstep (${reason}) for "${state.romName}" ` +
        `[CRC=${state.romCrc32}, delay=${state.engine.inputDelayFrames}f]`
    );
    ui.showScreenBanner(
      `STARTING "${state.romName}" AT FRAME #0...`, 'warn', 8000
    );
    ui.updateStatusStrip();
  }

  async function loadRomFromUint8(u8, name, options = {}) {
    const broadcastToPeer = typeof options === 'boolean'
      ? options : options.broadcastToPeer !== false;
    const isAutoDefault = Boolean(options && options.isAutoDefault);

    state.romUint8 = u8;
    state.romName = name || 'Game.nes';
    const sysId = detectSystemFromRomBytes(u8, state.romName);
    state.romBinaryString = sysId === 'nes'
      ? uint8ToBinaryString(u8) : 'BINARY_ROM';
    state.romCrc32 = computeRomCrc32(u8);
    state.isAutoDefaultRom = isAutoDefault;
    state.matchStarted = false;
    state.sendingRomSessionId = null;

    ensureRomInDropdown(options.dropdownKey || state.romName, u8);
    if (!isAutoDefault) {
      Promise.resolve(putCachedRomByCrc(state.romCrc32, state.romName, u8))
        .then(() => state.onCacheUpdated?.());
    }
    if (options?.serverCachedCrc === state.romCrc32) {
      state.roomRomUploadedCrc = state.romCrc32;
    } else if (!state.localServerRomKey && !isAutoDefault &&
               !state.isStaticOrigin && !state.ws?.isServerlessP2p &&
               isLocalHostRuntime()) {
      uploadRomToServerCache(state);
    }

    const w = sysId === 'sega_md' || sysId === 'arcade' ? 320 : 256;
    const h = sysId === 'sega_md' || sysId === 'snes'
      ? 224 : sysId === 'sega_sms' ? 192 : 240;
    ui.setConsoleResolution(w, h);

    let audioSub = 0;
    audio.resetBuffer?.();
    const onFrame = (fb) => ui.renderFrameToCanvas(fb);
    const onAudioSample = (l, r) => {
      const eff = sysId !== 'nes' ? 1 : state.holdTurboActive
        ? Math.max(4, state.turboMultiplier || 1) : state.turboMultiplier || 1;
      if (eff > 1 && ++audioSub % eff !== 0) return;
      audio.pushSample(l, r);
    };

    const prevCore = state.nes;
    state.nes = null; state.engine?.destroy?.(); state.engine = null;
    prevCore?.destroy?.();
    if (sysId === 'arcade') {
      state.nes = await createFbneoArcadeCore({
        romBytes: u8, romName: state.romName, onFrame, onAudioSample,
        onCoreProgress: (pct, info) => {
          const detail = formatTransferProgress(info || { pct });
          ui.setTransferStatus?.({
            phase: 'loading-core', romName: state.romName, pct, detail
          });
          if (options?.reportPeerCoreProgress && state.ws?.readyState === 1) {
            state.ws.send(JSON.stringify({
              type: 'rom_transfer_progress', stage: 'loading-core',
              pct, ...(info || {})
            }));
          }
        }
      });
      ui.setConsoleResolution(state.nes.width, state.nes.height);
    } else if (['sega_md', 'sega_sms', 'snes'].includes(sysId)) {
      state.nes = await createSegaGpgxCore({
        romBytes: u8, romName: state.romName,
        systemId: sysId, onFrame, onAudioSample
      });
    } else {
      state.nes = new jsnes.NES({ onFrame, onAudioSample });
      state.nes.loadROM(state.romBinaryString);
    }
    const isOnline = Boolean(
      state.ws && state.ws.readyState === 1 && state.peerConnected
    );
    state.engine = new NesNetplayEngine(state.nes, {
      localPlayer: state.localPlayerIndex, online: isOnline,
      enableRiftPacing: false,
      inputDelayFrames: resolveDesiredInputDelay(sysId),
      maxRollbackFrames: sysId === 'arcade' ? 36 : 56,
      saveBufferSize: sysId === 'arcade' ? 48 : 64
    });
    if (isOnline) state.engine.syncPaused = true;
    state.onEngineCreated?.();

    const shortName = state.romName.replace(
      /\.(nes|sfc|smc|fig|swc|md|gen|smd|bin|sms|gg|zip)$/i, ''
    );
    ui.romBadge.textContent = `ROM: ${shortName} [${state.romCrc32}]`;
    const mType = state.nes.rom.mapperType;
    ui.logDebug(
      `Loaded "${state.romName}" (Sys=${sysId}, CRC=${state.romCrc32}, ` +
        `Mapper=${mType}, CHR-RAM=${state.nes.rom.vromCount === 0})`
    );
    if (!isAutoDefault) {
      ui.showScreenBanner(options.fromCache
        ? `LOADED "${state.romName}" FROM CACHE (0 KB)!`
        : `LOADED "${state.romName}" [${state.romCrc32}]`, 'ok', 2800);
    }
    ui.resetSendRomButtons?.();
    if (state.ws?.readyState === 1) {
      state.ws.send(JSON.stringify({
        type: 'rom_status', romCrc32: state.romCrc32,
        romName: state.romName, isAutoDefaultRom: false
      }));
      if (broadcastToPeer && state.peerConnected &&
          state.localPlayerIndex === 1 &&
          state.partnerRomCrc32 === state.romCrc32) {
        startLockstepMatchAtFrameZero('Both PCs selected same ROM');
      }
    }
    state.onRomLoaded?.();
    ui.updateStatusStrip();
  }
  async function sendRomAndStateToPeer({
    resetToZero = false, forceChunks = false
  } = {}) {
    if (!state.romUint8 || !state.engine)
      return ui.showScreenBanner('LOAD A ROM BEFORE SENDING', 'warn', 3000);
    if (state.ws?.readyState !== 1)
      return ui.showScreenBanner('NOT CONNECTED - JOIN A ROOM', 'err', 3500);
    if (!state.peerConnected)
      return ui.showScreenBanner('WAITING FOR PARTNER TO JOIN', 'warn', 3500);
    const rnd = Math.random().toString(36).slice(2, 7);
    const newSessionId = `${Date.now().toString(36)}_${rnd}`;
    state.engine.localPlayer = state.localPlayerIndex;
    state.engine.online = true;
    state.engine.inputDelayFrames = resolveDesiredInputDelay();
    let syncState = null;
    if (resetToZero && state.nes && state.romBinaryString) {
      state.nes.loadROM(state.romBinaryString);
      state.engine.resetTimeline(0, newSessionId);
      const ocM = state.nesOverclockMode ?? (state.nesOverclockEnabled ? 1 : 0);
      syncState = {
        resetToZero: true, sessionId: newSessionId, frame: 0,
        inputDelayFrames: state.engine.inputDelayFrames,
        overclockEnabled: ocM > 0, overclockMode: ocM
      };
    } else {
      state.engine.sessionId = newSessionId;
      syncState = state.engine.exportSyncState();
      state.engine.importSyncState(syncState);
    }
    state.engine.syncPaused = true;
    armSyncAckWatchdog(newSessionId, 180000);
    await streamRomToPeer(
      state, ui, newSessionId, syncState, uint8ToBase64, forceChunks
    );
  }
  function sendStateSyncToPeer({ resetToZero = false } = {}) {
    if (state.ws?.readyState !== 1 || !state.engine) return;
    if (resetToZero && state.partnerRomCrc32 === state.romCrc32)
      return startLockstepMatchAtFrameZero('Reset to Frame #0');
    const newSessionId =
      `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    if (resetToZero && state.nes && state.romBinaryString) {
      state.nes.loadROM(state.romBinaryString);
      state.engine.resetTimeline(0, newSessionId);
    } else state.engine.sessionId = newSessionId;
    const syncState = state.engine.exportSyncState();
    state.engine.localPlayer = state.localPlayerIndex;
    state.engine.online = true;
    state.engine.importSyncState(syncState);
    state.engine.syncPaused = true;
    armSyncAckWatchdog(newSessionId);
    state.ws.send(JSON.stringify({
      type: 'state_sync', romName: state.romName,
      romCrc32: state.romCrc32, syncState
    }));
    ui.logDebug(`Sent state snapshot at frame #${syncState.frame}`);
    ui.showScreenBanner(`LOCKSTEP SYNCING "${state.romName}"...`, 'warn', 0);
    ui.updateStatusStrip();
  }

  const serverRomsSet = new Set();

  async function discoverLocalRoms() {
    try {
      const a = state.roomAuth
        ? `?auth=${encodeURIComponent(state.roomAuth)}` : '';
      const res = await fetch(buildApiUrl(state, `/api/local-roms${a}`));
      if (res.ok) {
        const data = await res.json();
        const sel = ui.localRomSelect;
        const prevVal = sel.value;
        const customOpts = [...sel.options].filter(
          (o) => o.value && state.customRomsMap.has(o.value)
        );
        sel.innerHTML = '<option value="">-- Select Game --</option>';
        for (const f of data.files || []) {
          serverRomsSet.add(f);
          const opt = document.createElement('option');
          opt.value = f;
          const s = f.indexOf('/');
          opt.textContent = s > 0
            ? `[${f.slice(0, s).toUpperCase()}] ${f.slice(s + 1)}` : f;
          sel.appendChild(opt);
        }
        for (const o of customOpts) {
          if (!serverRomsSet.has(o.value)) sel.appendChild(o);
        }
        if (prevVal && [...sel.options].some((o) => o.value === prevVal)) {
          sel.value = prevVal;
        }
      }
    } catch (e) { ui.logDebug(`Local ROM check failed: ${e.message}`); }
    state.onCacheUpdated?.();
    ui.updateStatusStrip();
  }

  async function fetchLocalRomByName(fileName, options = {}) {
    try {
      state.localServerRomKey = serverRomsSet.has(fileName) ? fileName : null;
      if (state.customRomsMap.has(fileName)) {
        return await loadRomFromUint8(
          state.customRomsMap.get(fileName), fileName, options
        );
      }
      state.localServerRomKey = fileName;
      const a = state.roomAuth
        ? `&auth=${encodeURIComponent(state.roomAuth)}` : '';
      const url = buildApiUrl(
        state, `/api/local-rom?file=${encodeURIComponent(fileName)}${a}`
      );
      const ld = await fetchRomBytesWithProgress(url, 'LOADING', fileName, ui);
      if (!ld) return;
      await loadRomFromUint8(ld.u8, ld.romName, {
        ...options, dropdownKey: fileName, serverCachedCrc: ld.romCrc32
      });
    } catch (e) {
      ui.logDebug(`Failed to load ${fileName}: ${e.message}`);
      ui.showScreenBanner(`LOAD FAILED: ${e.message}`, 'err', 5000);
    }
  }

  return {
    resolveDesiredInputDelay, armSyncAckWatchdog, loadRomFromUint8,
    startLockstepMatchAtFrameZero, sendRomAndStateToPeer, sendStateSyncToPeer,
    discoverLocalRoms, fetchLocalRomByName
  };
}
