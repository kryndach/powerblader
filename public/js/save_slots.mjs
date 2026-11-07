// Fast Save & Load Slot Manager (Slots 1-5) with LocalStorage & Online Sync
const SAVE_PREFIX = 'nes_save_v1_';
const ACTIVE_SLOT_KEY = 'nes_active_save_slot';
const TOTAL_SLOTS = 5;

export function createSaveSlotsManager(state, ui, romSync) {
  const memorySlots = new Map();

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

  function writeSlotEntry(romCrc32, slot, entry) {
    const key = makeStorageKey(romCrc32, slot);
    memorySlots.set(key, entry);
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

  function updateSlotSelectLabels() {
    if (!ui.saveSlotSelect) return;
    for (let s = 1; s <= TOTAL_SLOTS; s++) {
      const opt = ui.saveSlotSelect.querySelector(`option[value="${s}"]`);
      if (!opt) continue;
      const entry = state.romCrc32 ? readSlotEntry(state.romCrc32, s) : null;
      opt.textContent = entry ? `Slot ${s} [Saved]` : `Slot ${s} [Empty]`;
    }
  }

  function selectSlot(slotNum, showBanner = true) {
    const clamped = Math.max(1, Math.min(TOTAL_SLOTS, Math.floor(slotNum)));
    if (ui.saveSlotSelect) ui.saveSlotSelect.value = String(clamped);
    try {
      localStorage.setItem(ACTIVE_SLOT_KEY, String(clamped));
    } catch {}
    updateSlotSelectLabels();
    if (showBanner) {
      const hasSave = Boolean(
        state.romCrc32 && readSlotEntry(state.romCrc32, clamped)
      );
      const tag = hasSave ? 'SAVED' : 'EMPTY';
      ui.showScreenBanner(`SAVE SLOT #${clamped} [${tag}]`, 'ok', 1600);
    }
  }

  function saveToCurrentSlot() {
    if (!state.nes || !state.engine || !state.romCrc32) {
      ui.showScreenBanner('LOAD A .NES ROM BEFORE SAVING', 'warn', 2000);
      return false;
    }
    const slot = getCurrentSlot();
    const syncState = state.engine.exportSyncState();
    const entry = {
      slot,
      frame: syncState.frame,
      savedAt: Date.now(),
      romName: state.romName,
      romCrc32: state.romCrc32,
      syncState
    };
    writeSlotEntry(state.romCrc32, slot, entry);
    updateSlotSelectLabels();
    ui.logDebug(
      `Saved state to Slot #${slot} at frame #${syncState.frame}`
    );
    ui.showScreenBanner(
      `SAVED SLOT #${slot} (Frame #${syncState.frame})`,
      'ok',
      2200
    );
    return true;
  }

  function loadFromCurrentSlot() {
    if (!state.nes || !state.engine || !state.romCrc32) {
      ui.showScreenBanner('LOAD A .NES ROM BEFORE LOADING', 'warn', 2000);
      return false;
    }
    const slot = getCurrentSlot();
    const entry = readSlotEntry(state.romCrc32, slot);
    if (!entry || !entry.syncState) {
      ui.showScreenBanner(`SLOT #${slot} IS EMPTY`, 'warn', 2000);
      return false;
    }

    const rand = Math.random().toString(36).slice(2, 7);
    const newSessionId = `${Date.now().toString(36)}_${rand}`;
    const syncState = { ...entry.syncState, sessionId: newSessionId };
    const isOnline = Boolean(
      state.ws && state.ws.readyState === 1 && state.peerConnected
    );

    state.engine.localPlayer = state.localPlayerIndex;
    state.engine.online = isOnline;
    state.engine.inputDelayFrames = romSync.resolveDesiredInputDelay();
    state.engine.importSyncState(syncState, { preserveLocalInputDelay: true });

    if (state.nes.ppu && state.nes.ppu.buffer) {
      ui.renderFrameToCanvas(state.nes.ppu.buffer);
    }

    if (isOnline) {
      state.engine.syncPaused = true;
      romSync.armSyncAckWatchdog(newSessionId, 15000);
      state.ws.send(
        JSON.stringify({
          type: 'state_sync',
          romName: state.romName,
          romCrc32: state.romCrc32,
          syncState
        })
      );
      ui.logDebug(
        `Loaded Slot #${slot} (frame #${syncState.frame}) & synced to peer`
      );
      ui.showScreenBanner(
        `LOADED SLOT #${slot} (Frame #${syncState.frame}) - SYNCING...`,
        'ok',
        2500
      );
    } else {
      state.engine.syncPaused = false;
      ui.logDebug(`Loaded Slot #${slot} at frame #${syncState.frame}`);
      ui.showScreenBanner(
        `LOADED SLOT #${slot} (Frame #${syncState.frame})`,
        'ok',
        2200
      );
    }
    ui.updateStatusStrip();
    return true;
  }

  try {
    const savedSlot = localStorage.getItem(ACTIVE_SLOT_KEY);
    if (savedSlot && ui.saveSlotSelect) {
      ui.saveSlotSelect.value = savedSlot;
    }
  } catch {}
  updateSlotSelectLabels();

  return {
    getCurrentSlot,
    updateSlotSelectLabels,
    selectSlot,
    saveToCurrentSlot,
    loadFromCurrentSlot
  };
}
