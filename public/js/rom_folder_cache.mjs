// Local Disk Cache Folder via Browser File System Access API (CRC32-Indexed)
import { computeRomCrc32 } from '../../src/crc32.mjs';

const HANDLE_DB_NAME = 'nes_online_folder_handle_v1';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'cache_dir';
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const ROM_EXT_RE = /\.(nes|sfc|smc|fig|swc|md|gen|smd|bin|sms|gg|zip)$/i;
const KEY_PREFIX_RE = /^([0-9A-F]{8}|WASM_[A-Z0-9_]+)__(.+)$/i;
const WASM_FILE_RE = /^(WASM_[A-Z0-9_]+)\.wasm$/i;

let dirHandle = null;
const fileIndex = new Map();

function sanitizeFileName(name = 'rom.bin') {
  return String(name).replace(/^.*[\\/]/, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 96) || 'rom.bin';
}

function openHandleDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(HANDLE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(HANDLE_STORE)) {
          req.result.createObjectStore(HANDLE_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function persistDirHandle(handle) {
  const db = await openHandleDb();
  if (!db) return;
  try {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
  } catch {}
}

async function loadPersistedDirHandle() {
  const db = await openHandleDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export function isFolderCacheSupported() {
  return typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function';
}

export async function attachCacheDirectory(handle, { persist = true } = {}) {
  if (!handle || typeof handle.values !== 'function') return null;
  dirHandle = handle;
  fileIndex.clear();
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file') continue;
    const name = String(entry.name || '');
    const mWasm = WASM_FILE_RE.exec(name);
    if (mWasm) {
      fileIndex.set(mWasm[1].toUpperCase(), {
        fileHandle: entry, romName: name, diskName: name
      });
      continue;
    }
    const mPref = KEY_PREFIX_RE.exec(name);
    if (mPref) {
      fileIndex.set(mPref[1].toUpperCase(), {
        fileHandle: entry, romName: mPref[2], diskName: name
      });
      continue;
    }
    if (!ROM_EXT_RE.test(name)) continue;
    try {
      const file = await entry.getFile();
      if (file.size > 0 && file.size <= MAX_SCAN_BYTES) {
        const u8 = new Uint8Array(await file.arrayBuffer());
        const crc = computeRomCrc32(u8);
        if (!fileIndex.has(crc)) {
          fileIndex.set(crc, {
            fileHandle: entry, romName: name, diskName: name
          });
        }
      }
    } catch {}
  }
  if (persist) await persistDirHandle(handle);
  return getFolderCacheInfo();
}

export async function pickCacheFolder() {
  if (!isFolderCacheSupported()) return null;
  const handle = await window.showDirectoryPicker({
    id: 'nes_online_rom_cache', mode: 'readwrite'
  });
  return attachCacheDirectory(handle, { persist: true });
}

export async function restoreSavedCacheFolder() {
  if (!isFolderCacheSupported()) return null;
  try {
    const saved = await loadPersistedDirHandle();
    if (!saved || typeof saved.queryPermission !== 'function') return null;
    const perm = await saved.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return null;
    return await attachCacheDirectory(saved, { persist: false });
  } catch {
    return null;
  }
}

export async function getCachedFileFromFolder(keyRaw) {
  const key = String(keyRaw || '').trim().toUpperCase();
  if (!key || !dirHandle) return null;
  const entry = fileIndex.get(key);
  if (!entry?.fileHandle) return null;
  try {
    const file = await entry.fileHandle.getFile();
    const u8 = new Uint8Array(await file.arrayBuffer());
    return u8.byteLength > 0 ? { romName: entry.romName, u8 } : null;
  } catch {
    fileIndex.delete(key);
    return null;
  }
}

export async function putCachedFileToFolder(keyRaw, romName, u8) {
  const key = String(keyRaw || '').trim().toUpperCase();
  if (!key || !dirHandle || !u8?.byteLength) return false;
  if (typeof dirHandle.getFileHandle !== 'function') return false;
  const diskName = key.startsWith('WASM_')
    ? `${key}.wasm`
    : `${key}__${sanitizeFileName(romName)}`;
  try {
    const fh = await dirHandle.getFileHandle(diskName, { create: true });
    const writable = await fh.createWritable();
    await writable.write(u8);
    await writable.close();
    fileIndex.set(key, {
      fileHandle: fh, romName: romName || diskName, diskName
    });
    return true;
  } catch {
    return false;
  }
}

export async function deleteCachedFileFromFolder(keyRaw) {
  const key = String(keyRaw || '').trim().toUpperCase();
  if (!key || !dirHandle) return;
  const entry = fileIndex.get(key);
  fileIndex.delete(key);
  if (entry?.diskName && typeof dirHandle.removeEntry === 'function') {
    try { await dirHandle.removeEntry(entry.diskName); } catch {}
  }
}

export function getFolderCacheInfo() {
  return {
    connected: Boolean(dirHandle),
    folderName: dirHandle?.name || null,
    count: fileIndex.size,
    keys: [...fileIndex.keys()]
  };
}

export function clearFolderCacheForTests() {
  dirHandle = null;
  fileIndex.clear();
}
