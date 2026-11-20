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
    const arcMin = state.rttMs >= 160 ? 5 : 4;
    if (val === 'auto') {
      const rec = NesNetplayEngine.computeRecommendedInputDelay(
        state.rttMs,
        state.jitterMs,
        state.engine ? state.engine.rxClumpFrames : 0
      );
      return sysId === 'arcade' && state.peerConnected
        ? Math.max(arcMin, rec) : rec;
    }
    const parsed = Number(val);
    const delay = Number.isFinite(parsed) ? parsed : 2;
    if (sysId === 'arcade' && state.peerConnected && delay === 2) return arcMin;
    return delay;
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

    state.ws.send(JSON.stringify({
      type: 'match_start_req', sessionId: newSessionId,
      romCrc32: state.romCrc32, romName: state.romName,
      inputDelayFrames: state.engine.inputDelayFrames,
      overclockEnabled: Boolean(state.nesOverclockEnabled), reason
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
      const eff = state.holdTurboActive
        ? Math.max(4, state.turboMultiplier || 1)
        : state.turboMultiplier || 1;
      if (eff > 1 && ++audioSub % eff !== 0) return;
      audio.pushSample(l, r);
    };

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
    } else if (
      sysId === 'sega_md' || sysId === 'sega_sms' || sysId === 'snes'
    ) {
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
    state.engine?.destroy?.();
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
    const isChrRam = state.nes.rom.vromCount === 0;
    ui.logDebug(
      `Loaded ROM "${state.romName}" (Sys=${sysId}, ` +
        `CRC32=${state.romCrc32}, Mapper=${mType}, CHR-RAM=${isChrRam})`
    );

    if (!isAutoDefault) {
      const msg = options.fromCache
        ? `LOADED "${state.romName}" FROM CACHE (0 KB)!`
        : `LOADED "${state.romName}" [${state.romCrc32}]`;
      ui.showScreenBanner(msg, 'ok', 2800);
    }
    ui.resetSendRomButtons?.();

    if (state.ws && state.ws.readyState === 1) {
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
    if (typeof state.onRomLoaded === 'function') state.onRomLoaded();
    ui.updateStatusStrip();
  }

  async function sendRomAndStateToPeer({
    resetToZero = false, forceChunks = false
  } = {}) {
    if (!state.romUint8 || !state.engine) {
      return ui.showScreenBanner('LOAD A ROM BEFORE SENDING', 'warn', 3000);
    }
    if (!state.ws || state.ws.readyState !== 1) {
      return ui.showScreenBanner('NOT CONNECTED - JOIN A ROOM', 'err', 3500);
    }
    if (!state.peerConnected) {
      return ui.showScreenBanner('WAITING FOR PARTNER TO JOIN', 'warn', 3500);
    }
    const newSessionId =
      `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    state.engine.localPlayer = state.localPlayerIndex;
    state.engine.online = true;
    state.engine.inputDelayFrames = resolveDesiredInputDelay();
    let syncState = null;
    if (resetToZero && state.nes && state.romBinaryString) {
      state.nes.loadROM(state.romBinaryString);
      state.engine.resetTimeline(0, newSessionId);
      syncState = {
        resetToZero: true, sessionId: newSessionId, frame: 0,
        inputDelayFrames: state.engine.inputDelayFrames,
        overclockEnabled: Boolean(state.nesOverclockEnabled)
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
    if (!state.ws || state.ws.readyState !== 1 || !state.engine) return;
    if (resetToZero && state.partnerRomCrc32 === state.romCrc32) {
      return startLockstepMatchAtFrameZero('Reset to Frame #0');
    }
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
    ui.logDebug(
      `Sent lockstep state snapshot at frame #${syncState.frame}`
    );
    ui.showScreenBanner(`LOCKSTEP SYNCING "${state.romName}"...`, 'warn', 0);
    ui.updateStatusStrip();
  }

  const serverRomsSet = new Set();

  async function discoverLocalRoms() {
    try {
      const res = await fetch(buildApiUrl(state, '/api/local-roms'));
      if (res.ok) {
        const data = await res.json();
        ui.localRomSelect.innerHTML =
          '<option value="">-- Select Game --</option>';
        for (const f of data.files || []) {
          serverRomsSet.add(f);
          const opt = document.createElement('option');
          opt.value = f;
          const slash = f.indexOf('/');
          opt.textContent = slash > 0
            ? `[${f.slice(0, slash).toUpperCase()}] ${f.slice(slash + 1)}`
            : f;
          ui.localRomSelect.appendChild(opt);
        }
        ui.localRomSelect.value = '';
      }
    } catch (e) { ui.logDebug(`Local ROM check failed: ${e.message}`); }
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
      const url = buildApiUrl(
        state, `/api/local-rom?file=${encodeURIComponent(fileName)}`
      );
      const loaded = await fetchRomBytesWithProgress(
        url, 'LOADING', fileName, ui
      );
      if (!loaded) return;
      await loadRomFromUint8(loaded.u8, loaded.romName, {
        ...options, dropdownKey: fileName, serverCachedCrc: loaded.romCrc32
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
