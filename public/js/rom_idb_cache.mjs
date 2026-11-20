// Persistent Disk Folder, IndexedDB & In-Memory ROM/WASM Cache by CRC32
import {
  getCachedFileFromFolder, putCachedFileToFolder, deleteCachedFileFromFolder,
  attachCacheDirectory, getFolderCacheInfo, clearFolderCacheForTests
} from './rom_folder_cache.mjs';

export { attachCacheDirectory, getFolderCacheInfo, clearFolderCacheForTests };

const IDB_NAME = 'nes_online_rom_cache_v1';
const IDB_STORE = 'roms';
const memCacheFallback = new Map();

function openRomIdb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function getCachedRomByCrc(crc) {
  const key = String(crc || '').trim().toUpperCase();
  if (!key) return null;
  if (memCacheFallback.has(key)) return memCacheFallback.get(key);
  const diskHit = await getCachedFileFromFolder(key);
  if (diskHit?.u8) {
    return { romName: diskHit.romName, u8: diskHit.u8, source: 'folder' };
  }
  const db = await openRomIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const val = req.result;
        if (val?.u8) {
          const u8 = new Uint8Array(val.u8);
          putCachedFileToFolder(key, val.romName, u8).catch(() => {});
          resolve({ romName: val.romName, u8, source: 'idb' });
        } else resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function putCachedRomByCrc(crc, romName, u8) {
  const key = String(crc || '').trim().toUpperCase();
  if (!key || !u8?.byteLength) return;
  await putCachedFileToFolder(key, romName, u8).catch(() => {});
  if (typeof indexedDB === 'undefined') {
    memCacheFallback.set(key, { romName, u8: new Uint8Array(u8) });
    return;
  }
  const db = await openRomIdb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ romName, u8, ts: Date.now() }, key);
  } catch {}
}

export async function deleteCachedRomByCrc(crc) {
  const key = String(crc || '').trim().toUpperCase();
  if (!key) return;
  memCacheFallback.delete(key);
  await deleteCachedFileFromFolder(key).catch(() => {});
  const db = await openRomIdb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
  } catch {}
}

export function clearMemRomCacheForTests() {
  memCacheFallback.clear();
  clearFolderCacheForTests();
}
