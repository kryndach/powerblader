// Top-Bar ROM Cache Button, Auto-Cached Dropdown & Folder Reconnect Controller
import {
  isFolderCacheSupported, pickCacheFolder, restoreSavedCacheFolder,
  getFolderCacheInfo, getPendingSavedFolderName, reconnectSavedCacheFolder
} from './rom_folder_cache.mjs';
import { getCachedRomByCrc, listCachedRoms } from './rom_idb_cache.mjs';

const baseNameLow = (s) =>
  String(s || '').replace(/^.*[\\/]/, '').trim().toLowerCase();

export async function loadCachedRomSelection(val, state, ui, romSync) {
  const crc = String(val || '').replace(/^cached:/, '').trim().toUpperCase();
  if (!crc) return false;
  const hit = await getCachedRomByCrc(crc);
  if (!hit?.u8) {
    ui?.showScreenBanner?.('CACHED ROM NOT FOUND', 'warn', 2500);
    return false;
  }
  state.localServerRomKey = null;
  await romSync.loadRomFromUint8(hit.u8, hit.romName, {
    broadcastToPeer: true, isAutoDefault: false,
    fromCache: true, dropdownKey: val
  });
  return true;
}

export function setupRomCacheFolderUi(state, ui, onFolderReady = null) {
  let btn = document.getElementById('cacheFolderBtn');
  if (!btn && ui?.topSendRomBtn) {
    btn = document.createElement('button');
    btn.id = 'cacheFolderBtn';
    btn.textContent = 'Cache Folder';
    btn.title =
      'ROMs auto-cache in browser. Optional: pick a Windows folder to keep ' +
      'files on disk across random URLs';
    ui.topSendRomBtn.insertAdjacentElement('afterend', btn);
  }

  function syncCachedDropdown(items) {
    const sel = ui?.localRomSelect;
    if (!sel) return;
    const prevVal = sel.value;
    const existingNames = new Set();
    for (const opt of [...sel.options]) {
      if (opt.dataset.cachedRom === '1') opt.remove();
      else if (opt.value) existingNames.add(baseNameLow(opt.value));
    }
    for (const item of items) {
      if (existingNames.has(baseNameLow(item.romName))) continue;
      const opt = document.createElement('option');
      opt.value = `cached:${item.crc}`;
      opt.textContent = `[CACHED] ${item.romName}`;
      opt.dataset.cachedRom = '1';
      sel.appendChild(opt);
    }
    if (prevVal && [...sel.options].some((o) => o.value === prevVal)) {
      sel.value = prevVal;
    }
  }

  async function refreshLabel() {
    const items = await listCachedRoms().catch(() => []);
    syncCachedDropdown(items);
    if (!btn) return;
    const info = getFolderCacheInfo();
    const pending = getPendingSavedFolderName();
    const total = Math.max(items.length, info.count);
    if (info.connected) {
      btn.textContent = `Cache (${total})`;
      btn.classList.add('active-toggle');
      btn.title = `Folder "${info.folderName}" + browser cache (${total} ` +
        'ROMs). Click to switch folder.';
    } else if (pending) {
      btn.textContent = total > 0
        ? `Reconnect (${total})` : 'Reconnect Cache';
      btn.classList.add('active-toggle');
      btn.title = `Click once to reconnect Windows folder "${pending}" ` +
        `(${total} ROMs auto-cached in browser).`;
    } else if (total > 0) {
      btn.textContent = `Cache (${total})`;
      btn.classList.add('active-toggle');
      btn.title = `${total} ROM(s) auto-cached in Chrome (pick from Select ` +
        'Game). Optional: click to also link a Windows folder.';
    } else {
      btn.textContent = 'Cache Folder';
      btn.classList.remove('active-toggle');
      btn.title = 'ROMs auto-cache in browser automatically. Optional: ' +
        'click to link a Windows folder on disk.';
    }
  }

  if (btn) {
    btn.addEventListener('click', async () => {
      if (!isFolderCacheSupported()) {
        const items = await listCachedRoms().catch(() => []);
        return ui.showScreenBanner(
          `BROWSER AUTO-CACHE: ${items.length} ROM(S) SAVED`, 'ok', 2800
        );
      }
      try {
        const hadPending = Boolean(getPendingSavedFolderName());
        const info = hadPending
          ? await reconnectSavedCacheFolder() || await pickCacheFolder()
          : await pickCacheFolder();
        if (!info) return;
        await refreshLabel();
        ui.logDebug(
          `Attached local ROM cache folder "${info.folderName}" ` +
            `(${info.count} files indexed by CRC32).`
        );
        ui.showScreenBanner(
          `CACHE FOLDER "${info.folderName}" READY (${info.count} FILES)`,
          'ok', 3000
        );
        onFolderReady?.(info);
      } catch (e) {
        if (e?.name !== 'AbortError') {
          ui.logDebug(`Cache folder picker warning: ${e.message}`);
        }
      }
    });
  }

  restoreSavedCacheFolder().then(async (info) => {
    await refreshLabel();
    if (!info) return;
    ui.logDebug(
      `Restored local ROM cache folder "${info.folderName}" ` +
        `(${info.count} files).`
    );
    onFolderReady?.(info);
  }).catch(() => refreshLabel());

  return { refreshLabel };
}
