// Top-Bar Local ROM Cache Folder Button & Auto-Reconnect Controller
import {
  isFolderCacheSupported, pickCacheFolder, restoreSavedCacheFolder,
  getFolderCacheInfo
} from './rom_folder_cache.mjs';

export function setupRomCacheFolderUi(state, ui, onFolderReady = null) {
  if (!isFolderCacheSupported() || !ui?.topSendRomBtn) return null;
  if (document.getElementById('cacheFolderBtn')) return null;

  const btn = document.createElement('button');
  btn.id = 'cacheFolderBtn';
  btn.textContent = 'Cache Folder';
  btn.title =
    'Pick a local Windows folder to permanently cache ROMs & WASM cores ' +
    'by CRC32 across all Pinggy sessions';
  ui.topSendRomBtn.insertAdjacentElement('afterend', btn);

  function refreshLabel() {
    const info = getFolderCacheInfo();
    if (info.connected) {
      btn.textContent = `Cache (${info.count})`;
      btn.classList.add('active-toggle');
      btn.title = `Local ROM cache folder "${info.folderName}" ` +
        `(${info.count} cached files). Click to switch folder.`;
    } else {
      btn.textContent = 'Cache Folder';
      btn.classList.remove('active-toggle');
    }
  }

  btn.addEventListener('click', async () => {
    try {
      const info = await pickCacheFolder();
      if (!info) return;
      refreshLabel();
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

  restoreSavedCacheFolder().then((info) => {
    if (!info) return;
    refreshLabel();
    ui.logDebug(
      `Restored local ROM cache folder "${info.folderName}" ` +
        `(${info.count} files).`
    );
    onFolderReady?.(info);
  }).catch(() => {});

  return { refreshLabel };
}
