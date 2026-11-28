// Fast Save & Load Slot Manager (Slots 1-5), Disk Persistence & Local Save File
import { buildApiUrl } from './server_endpoint.mjs';
const SAVE_PREFIX = 'nes_save_v1_';
const ACTIVE_SLOT_KEY = 'nes_active_save_slot';
const TOTAL_SLOTS = 5;

export function createSaveSlotsManager(state, ui, romSync) {
  const memorySlots = new Map();
  const diskSavedKeys = new Set();

  function makeStorageKey(romCrc32, slot) {
    return `${SAVE_PREFIX}${romCrc32}_slot_${slot}`;
  }

  function readSlotEntry(romCrc32, slot) {
    if (!romCrc32) return null;
    const key = makeStorageKey(romCrc32, slot);
    if (memorySlots.has(key)) return memorySlots.get(key);
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.syncState) {
        memorySlots.set(key, parsed);
        return parsed;
      }
    } catch {}
    return null;
  }

  function canUseServerApi() {
    if (typeof fetch !== 'function' || state.ws?.isServerlessP2p) return false;
    return !state.isStaticOrigin || Boolean(state.apiBaseUrl);
  }

  function saveApiUrl(query = '') {
    const parts = [];
    if (query) parts.push(query);
    if (state.roomAuth) {
      parts.push(`auth=${encodeURIComponent(state.roomAuth)}`);
    }
    const qs = parts.length ? `?${parts.join('&')}` : '';
    return buildApiUrl(state, `/api/save-slot${qs}`);
  }

  function writeSlotEntry(romCrc32, slot, entry) {
    const key = makeStorageKey(romCrc32, slot);
    memorySlots.set(key, entry);
    diskSavedKeys.add(key);
    if (canUseServerApi()) {
      const headers = { 'Content-Type': 'application/json' };
      if (state.roomAuth) headers['X-Room-Auth'] = state.roomAuth;
      fetch(saveApiUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify({ romCrc32, slot, entry })
      }).catch(() => {});
    }
    try {
      const json = JSON.stringify(entry);
      if (json.length > 512 * 1024) return;
      try {
        localStorage.setItem(key, json);
      } catch {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(SAVE_PREFIX) && k !== key) {
            try {
              const item = JSON.parse(localStorage.getItem(k));
              const t = item?.savedAt || 0;
              if (t < oldestTime) {
                oldestTime = t;
                oldestKey = k;
              }
            } catch {
              oldestKey = k;
              break;
            }
          }
        }
        if (oldestKey) localStorage.removeItem(oldestKey);
        localStorage.setItem(key, json);
      }
    } catch {}
  }

  function getCurrentSlot() {
    const val = Number(ui.saveSlotSelect ? ui.saveSlotSelect.value : 1);
    return val >= 1 && val <= TOTAL_SLOTS ? val : 1;
  }

  function renderSlotOptions() {
    if (!ui.saveSlotSelect) return;
    for (let s = 1; s <= TOTAL_SLOTS; s++) {
      const opt = ui.saveSlotSelect.querySelector(`option[value="${s}"]`);
      if (!opt) continue;
      const key = state.romCrc32 ? makeStorageKey(state.romCrc32, s) : '';
      const has = Boolean(
        state.romCrc32 &&
          (readSlotEntry(state.romCrc32, s) || diskSavedKeys.has(key))
      );
      opt.textContent = has ? `Slot ${s} [Saved]` : `Slot ${s} [Empty]`;
    }
  }

  function updateSlotSelectLabels() {
    renderSlotOptions();
    if (!state.romCrc32 || !canUseServerApi()) return;
    const crc = state.romCrc32;
    fetch(saveApiUrl(`crc=${encodeURIComponent(crc)}`))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.savedSlots)) return;
        for (const s of data.savedSlots) {
          diskSavedKeys.add(makeStorageKey(crc, s));
        }
        renderSlotOptions();
      })
      .catch(() => {});
  }

  function selectSlot(slotNum, showBanner = true) {
    const clamped = Math.max(1, Math.min(TOTAL_SLOTS, Math.floor(slotNum)));
    if (ui.saveSlotSelect) ui.saveSlotSelect.value = String(clamped);
    try {
      localStorage.setItem(ACTIVE_SLOT_KEY, String(clamped));
    } catch {}
    renderSlotOptions();
    if (showBanner) {
      const key = state.romCrc32 ? makeStorageKey(state.romCrc32, clamped) : '';
      const hasSave = Boolean(
        state.romCrc32 &&
          (readSlotEntry(state.romCrc32, clamped) || diskSavedKeys.has(key))
      );
      const tag = hasSave ? 'SAVED' : 'EMPTY';
      ui.showScreenBanner(`SAVE SLOT #${clamped} [${tag}]`, 'ok', 1600);
    }
  }

  function buildCurrentSaveEntry(slot) {
    const syncState = state.engine.exportSyncState();
    return {
      slot,
      frame: syncState.frame,
      savedAt: Date.now(),
      romName: state.romName,
      romCrc32: state.romCrc32,
      syncState
    };
  }

  function saveToCurrentSlot() {
    if (!state.nes || !state.engine || !state.romCrc32) {
      ui.showScreenBanner('LOAD A ROM BEFORE SAVING', 'warn', 2000);
      return false;
    }
    const slot = getCurrentSlot();
    const entry = buildCurrentSaveEntry(slot);
    writeSlotEntry(state.romCrc32, slot, entry);
    renderSlotOptions();
    ui.logDebug(`Saved state to Slot #${slot} at frame #${entry.frame}`);
    ui.showScreenBanner(
      `SAVED SLOT #${slot} (Frame #${entry.frame})`, 'ok', 2200
    );
    return true;
  }

  function applyLoadedEntry(entry, labelPrefix) {
    const rand = Math.random().toString(36).slice(2, 7);
    const newSessionId = `${Date.now().toString(36)}_${rand}`;
    const syncState = { ...entry.syncState, sessionId: newSessionId };
    if (syncState.nesState?.ppu) {
      const oc = state.nesOverclockMode ?? (state.nesOverclockEnabled ? 1 : 0);
      syncState.nesState = {
        ...syncState.nesState,
        ppu: {
          ...syncState.nesState.ppu,
          _overclockMode: oc,
          _overclockEnabled: oc > 0
        }
      };
    }
    const isOnline = Boolean(
      state.ws && state.ws.readyState === 1 && state.peerConnected
    );
    state.engine.localPlayer = state.localPlayerIndex;
    state.engine.online = isOnline;
    state.engine.inputDelayFrames = romSync.resolveDesiredInputDelay();
    state.engine.importSyncState(syncState, { preserveLocalInputDelay: true });
    state.audio?.resetBuffer?.();

    const fb = state.nes.getFrameBuffer
      ? state.nes.getFrameBuffer()
      : state.nes.ppu?.buffer;
    if (fb) ui.renderFrameToCanvas(fb);

    if (isOnline) {
      state.engine.syncPaused = true;
      romSync.armSyncAckWatchdog(newSessionId, 15000);
      state.ws.send(JSON.stringify({
        type: 'state_sync',
        romName: state.romName,
        romCrc32: state.romCrc32,
        syncState
      }));
      ui.logDebug(
        `Loaded ${labelPrefix} (frame #${syncState.frame}) & synced to peer`
      );
      ui.showScreenBanner(
        `LOADED ${labelPrefix} (Frame #${syncState.frame}) - SYNCING...`,
        'ok',
        2500
      );
    } else {
      state.engine.syncPaused = false;
      ui.logDebug(`Loaded ${labelPrefix} at frame #${syncState.frame}`);
      ui.showScreenBanner(
        `LOADED ${labelPrefix} (Frame #${syncState.frame})`, 'ok', 2200
      );
    }
    ui.updateStatusStrip();
    return true;
  }

  async function loadFromCurrentSlot() {
    if (!state.nes || !state.engine || !state.romCrc32) {
      ui.showScreenBanner('LOAD A ROM BEFORE LOADING', 'warn', 2000);
      return false;
    }
    const slot = getCurrentSlot();
    let entry = readSlotEntry(state.romCrc32, slot);
    if (!entry && canUseServerApi()) {
      try {
        const q = `crc=${encodeURIComponent(state.romCrc32)}&slot=${slot}`;
        const res = await fetch(saveApiUrl(q));
        if (res.ok) {
          const data = await res.json();
          if (data?.entry?.syncState) {
            entry = data.entry;
            memorySlots.set(makeStorageKey(state.romCrc32, slot), entry);
          }
        }
      } catch {}
    }
    if (!entry || !entry.syncState) {
      ui.showScreenBanner(`SLOT #${slot} IS EMPTY`, 'warn', 2000);
      return false;
    }
    return applyLoadedEntry(entry, `SLOT #${slot}`);
  }

  function exportSaveToFile() {
    if (!state.nes || !state.engine || !state.romCrc32) {
      ui.showScreenBanner('LOAD A ROM BEFORE EXPORTING SAVE', 'warn', 2000);
      return false;
    }
    const slot = getCurrentSlot();
    const entry = buildCurrentSaveEntry(slot);
    writeSlotEntry(state.romCrc32, slot, entry);
    renderSlotOptions();
    const cleanRom = String(state.romName || 'Game')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 32);
    const fileName = `${cleanRom}_${state.romCrc32}_slot${slot}.sav.json`;
    const blob = new Blob([JSON.stringify(entry)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    ui.logDebug(`Exported save file "${fileName}" (frame #${entry.frame})`);
    ui.showScreenBanner(`DOWNLOADED "${fileName}"`, 'ok', 2600);
    return true;
  }

  async function importSaveFromFile(file) {
    if (!file) return false;
    if (!state.nes || !state.engine || !state.romCrc32) {
      ui.showScreenBanner('LOAD THE GAME ROM FIRST', 'warn', 2500);
      return false;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const syncState = parsed?.syncState || (parsed?.frame !== undefined
        ? parsed : null);
      if (!syncState) throw new Error('Invalid save state file');
      if (parsed.romCrc32 && parsed.romCrc32 !== state.romCrc32) {
        ui.showScreenBanner(
          `SAVE FILE CRC (${parsed.romCrc32}) != ROM (${state.romCrc32})`,
          'warn',
          3500
        );
      }
      const slot = getCurrentSlot();
      const entry = {
        slot,
        frame: syncState.frame || 0,
        savedAt: Date.now(),
        romName: state.romName,
        romCrc32: state.romCrc32,
        syncState
      };
      writeSlotEntry(state.romCrc32, slot, entry);
      renderSlotOptions();
      return applyLoadedEntry(entry, `FILE "${file.name}"`);
    } catch (e) {
      ui.logDebug(`Save file import failed: ${e.message}`);
      ui.showScreenBanner(`SAVE LOAD FAILED: ${e.message}`, 'err', 3500);
      return false;
    }
  }

  try {
    const savedSlot = localStorage.getItem(ACTIVE_SLOT_KEY);
    if (savedSlot && ui.saveSlotSelect) {
      ui.saveSlotSelect.value = savedSlot;
    }
  } catch {}
  renderSlotOptions();

  return {
    getCurrentSlot,
    updateSlotSelectLabels,
    selectSlot,
    saveToCurrentSlot,
    loadFromCurrentSlot,
    exportSaveToFile,
    importSaveFromFile
  };
}
