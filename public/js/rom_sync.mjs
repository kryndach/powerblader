// ROM Loader, Local Cartridge Discovery, Lockstep Barrier & Chunked Transfer
import {
  NesNetplayEngine, computeRomCrc32, detectSystemFromRomBytes
} from '/src/netplay_engine.mjs';
import {
  uint8ToBinaryString, uint8ToBase64, base64ToUint8
} from '/src/crc32.mjs';
import { createSegaGpgxCore, ensureGpgxRuntime } from '/src/sega_gpgx_core.mjs';
import { createFbneoArcadeCore } from '/src/fbneo_arcade_core.mjs';

export { base64ToUint8 };
const jsnes = window.jsnes;
ensureGpgxRuntime().catch(() => {});

export function createRomSyncManager(state, ui, audio) {
  function resolveDesiredInputDelay() {
    const sel = ui.topInputDelaySelect || ui.inputDelaySelect;
    const val = (sel ? sel.value : '2') || '2';
    if (val === 'auto') {
      return NesNetplayEngine.computeRecommendedInputDelay(
        state.rttMs,
        state.jitterMs,
        state.engine ? state.engine.rxClumpFrames : 0
      );
    }
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : 2;
  }

  function ensureRomInDropdown(name, u8) {
    if (!name) return;
    if (u8) state.customRomsMap.set(name, u8);
    let existing = Array.from(ui.localRomSelect.options).find(
      (o) => o.value === name
    );
    if (!existing) {
      existing = document.createElement('option');
      existing.value = name;
      existing.textContent = name;
      ui.localRomSelect.appendChild(existing);
    }
    ui.localRomSelect.value = name;
  }

  function armSyncAckWatchdog(sessionId, timeoutMs = 45000) {
    if (state.syncAckTimeout) clearTimeout(state.syncAckTimeout);
    state.syncAckTimeout = setTimeout(() => {
      if (
        state.engine &&
        state.engine.syncPaused &&
        state.engine.sessionId === sessionId
      ) {
        state.engine.syncPaused = false;
        state.matchStarted = true;
        ui.logDebug('Sync ACK timeout elapsed; unpausing emulation.');
        ui.updateStatusStrip();
      }
    }, timeoutMs);
  }

  function startLockstepMatchAtFrameZero(
    reason = 'ROM CRC32 Match',
    force = false
  ) {
    if (
      !state.ws ||
      state.ws.readyState !== 1 ||
      !state.peerConnected ||
      !state.romUint8 ||
      !state.romBinaryString ||
      !state.engine
    ) {
      return;
    }
    if (!force && state.syncAckTimeout) return;

    const rand = Math.random().toString(36).slice(2, 7);
    const newSessionId = `${Date.now().toString(36)}_${rand}`;
    state.nes.loadROM(state.romBinaryString);
    state.engine.localPlayer = state.localPlayerIndex;
    state.engine.online = true;
    state.engine.enableRiftPacing = true;
    state.engine.inputDelayFrames = resolveDesiredInputDelay();
    state.engine.resetTimeline(0, newSessionId);
    state.engine.syncPaused = true;
    state.matchStarted = false;
    armSyncAckWatchdog(newSessionId, 12000);

    state.ws.send(
      JSON.stringify({
        type: 'match_start_req',
        sessionId: newSessionId,
        romCrc32: state.romCrc32,
        romName: state.romName,
        inputDelayFrames: state.engine.inputDelayFrames,
        reason
      })
    );
    ui.logDebug(
      `Initiated Frame #0 lockstep (${reason}) for "${state.romName}" ` +
        `[CRC=${state.romCrc32}, delay=${state.engine.inputDelayFrames}f]`
    );
    ui.showScreenBanner(
      `STARTING "${state.romName}" AT FRAME #0...`, 'warn', 0
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

    ensureRomInDropdown(options.dropdownKey || state.romName, u8);

    const w = sysId === 'sega_md' || sysId === 'arcade' ? 320 : 256;
    const h = sysId === 'sega_md' || sysId === 'snes'
      ? 224 : sysId === 'sega_sms' ? 192 : 240;
    ui.setConsoleResolution(w, h);

    let audioSub = 0;
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
        romBytes: u8, romName: state.romName, onFrame, onAudioSample
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
    state.engine = new NesNetplayEngine(state.nes, {
      localPlayer: state.localPlayerIndex,
      online: isOnline,
      enableRiftPacing: true,
      inputDelayFrames: resolveDesiredInputDelay(),
      maxRollbackFrames: 36,
      saveBufferSize: sysId === 'nes' ? 96 : 48
    });

    if (isOnline) state.engine.syncPaused = true;

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
      ui.showScreenBanner(
        `LOADED "${state.romName}" [${state.romCrc32}]`, 'ok', 2800
      );
    }

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

  function sendRomAndStateToPeer({ resetToZero = false } = {}) {
    if (!state.ws || state.ws.readyState !== 1 || !state.romUint8) return;
    if (!state.engine) return;
    const rand = Math.random().toString(36).slice(2, 7);
    const newSessionId = `${Date.now().toString(36)}_${rand}`;
    if (resetToZero && state.nes && state.romBinaryString) {
      state.nes.loadROM(state.romBinaryString);
      state.engine.resetTimeline(0, newSessionId);
    } else {
      state.engine.sessionId = newSessionId;
    }

    const syncState = state.engine.exportSyncState();
    state.engine.localPlayer = state.localPlayerIndex;
    state.engine.online = true;
    state.engine.importSyncState(syncState);
    state.engine.syncPaused = true;
    armSyncAckWatchdog(newSessionId, 60000);

    const chunkSize = 16 * 1024;
    const totalBytes = state.romUint8.length;
    const totalChunks = Math.ceil(totalBytes / chunkSize);
    const kb = Math.round(totalBytes / 1024);

    ui.logDebug(
      `Sending ROM "${state.romName}" (${kb} KB in ${totalChunks} chunks)...`
    );
    ui.showScreenBanner(`SENDING "${state.romName}" (${kb} KB)...`, 'warn', 0);
    ui.updateStatusStrip();

    state.ws.send(JSON.stringify({
      type: 'rom_chunk_start', sessionId: newSessionId,
      romName: state.romName, romCrc32: state.romCrc32,
      isAutoDefaultRom: state.isAutoDefaultRom,
      totalBytes, totalChunks, syncState
    }));
    for (let i = 0; i < totalChunks; i++) {
      const end = Math.min(totalBytes, (i + 1) * chunkSize);
      const slice = state.romUint8.subarray(i * chunkSize, end);
      state.ws.send(JSON.stringify({
        type: 'rom_chunk_data', sessionId: newSessionId,
        index: i, dataB64: uint8ToBase64(slice)
      }));
    }
    state.ws.send(
      JSON.stringify({ type: 'rom_chunk_end', sessionId: newSessionId })
    );
  }

  function sendStateSyncToPeer({ resetToZero = false } = {}) {
    if (!state.ws || state.ws.readyState !== 1 || !state.engine) return;
    if (resetToZero && state.partnerRomCrc32 === state.romCrc32) {
      startLockstepMatchAtFrameZero('Reset to Frame #0');
      return;
    }
    const rand = Math.random().toString(36).slice(2, 7);
    const newSessionId = `${Date.now().toString(36)}_${rand}`;
    if (resetToZero && state.nes && state.romBinaryString) {
      state.nes.loadROM(state.romBinaryString);
      state.engine.resetTimeline(0, newSessionId);
    } else {
      state.engine.sessionId = newSessionId;
    }

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

  async function discoverLocalRoms() {
    try {
      const res = await fetch('/api/local-roms');
      if (res.ok) {
        const data = await res.json();
        ui.localRomSelect.innerHTML =
          '<option value="">-- Select Game --</option>';
        if (Array.isArray(data.files) && data.files.length > 0) {
          for (const f of data.files) {
            const opt = document.createElement('option');
            opt.value = f;
            const slash = f.indexOf('/');
            opt.textContent = slash > 0
              ? `[${f.slice(0, slash).toUpperCase()}] ${f.slice(slash + 1)}`
              : f;
            ui.localRomSelect.appendChild(opt);
          }
        }
        ui.localRomSelect.value = '';
      }
    } catch (e) {
      ui.logDebug(`Local ROM check failed: ${e.message}`);
    }
    ui.updateStatusStrip();
  }

  async function fetchLocalRomByName(fileName, options = {}) {
    try {
      if (state.customRomsMap.has(fileName)) {
        await loadRomFromUint8(
          state.customRomsMap.get(fileName), fileName, options
        );
        return;
      }
      const url = `/api/local-rom?file=${encodeURIComponent(fileName)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const hdr = res.headers.get('X-Rom-Filename');
      const rName = hdr ? decodeURIComponent(hdr) : fileName;
      const buf = await res.arrayBuffer();
      await loadRomFromUint8(new Uint8Array(buf), rName, {
        ...options,
        dropdownKey: fileName
      });
    } catch (e) {
      ui.logDebug(`Failed to load ${fileName}: ${e.message}`);
      ui.showScreenBanner(`LOAD FAILED: ${e.message}`, 'err', 5000);
    }
  }

  return {
    resolveDesiredInputDelay,
    armSyncAckWatchdog,
    loadRomFromUint8,
    startLockstepMatchAtFrameZero,
    sendRomAndStateToPeer,
    sendStateSyncToPeer,
    discoverLocalRoms,
    fetchLocalRomByName
  };
}
