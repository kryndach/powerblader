// Server-Side ROM & Archive (.zip / .rar / .7z) Extractor & Local ROM API
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import {
  isSupportedRomFile,
  isArchiveFile,
  isSupportedRomOrArchiveFile
} from '../src/core_adapter.mjs';

const WINRAR_PATHS = [
  'C:\\Program Files\\WinRAR\\WinRAR.exe',
  'C:\\Program Files (x86)\\WinRAR\\WinRAR.exe'
];
const UNRAR_PATHS = [
  'C:\\Program Files\\WinRAR\\UnRAR.exe',
  'C:\\Program Files (x86)\\WinRAR\\UnRAR.exe'
];
const SEVENZIP_PATHS = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe'
];

function findFirstExisting(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function extractRomFromZipBuffer(buf) {
  const u8 = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (u8.length < 30 || u8.readUInt32LE(0) !== 0x04034b50) return null;

  let eocdOffset = -1;
  const minEocd = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= minEocd; i--) {
    if (u8.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset >= 0) {
    const totalEntries = u8.readUInt16LE(eocdOffset + 10);
    let cdOffset = u8.readUInt32LE(eocdOffset + 16);
    for (let e = 0; e < totalEntries && cdOffset + 46 <= u8.length; e++) {
      if (u8.readUInt32LE(cdOffset) !== 0x02014b50) break;
      const method = u8.readUInt16LE(cdOffset + 10);
      const compSize = u8.readUInt32LE(cdOffset + 20);
      const nameLen = u8.readUInt16LE(cdOffset + 28);
      const extraLen = u8.readUInt16LE(cdOffset + 30);
      const commentLen = u8.readUInt16LE(cdOffset + 32);
      const localHdrOff = u8.readUInt32LE(cdOffset + 42);
      const entryName = u8
        .subarray(cdOffset + 46, cdOffset + 46 + nameLen)
        .toString('utf8');
      cdOffset += 46 + nameLen + extraLen + commentLen;

      const baseName = path.basename(entryName);
      if (!isSupportedRomFile(baseName)) continue;
      if (localHdrOff + 30 > u8.length) continue;
      if (u8.readUInt32LE(localHdrOff) !== 0x04034b50) continue;

      const lNameLen = u8.readUInt16LE(localHdrOff + 26);
      const lExtraLen = u8.readUInt16LE(localHdrOff + 28);
      const dataStart = localHdrOff + 30 + lNameLen + lExtraLen;
      const rawSlice = u8.subarray(dataStart, dataStart + compSize);
      if (method === 0) {
        return { romName: baseName, romBuffer: Buffer.from(rawSlice) };
      }
      if (method === 8) {
        return {
          romName: baseName,
          romBuffer: zlib.inflateRawSync(rawSlice)
        };
      }
    }
  }
  return null;
}

function findRomRecursive(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = findRomRecursive(full);
      if (sub) return sub;
    } else if (isSupportedRomFile(ent.name)) {
      return full;
    }
  }
  return null;
}

function extractArchiveToDir(archivePath, outDir) {
  const lower = archivePath.toLowerCase();
  const winrar = findFirstExisting(WINRAR_PATHS);
  const unrar = findFirstExisting(UNRAR_PATHS);
  const sevenZip = findFirstExisting(SEVENZIP_PATHS);

  const outSlash = outDir + path.sep;
  const attempts = [];
  if (lower.endsWith('.rar')) {
    if (unrar) {
      attempts.push([unrar, ['x', '-y', '-inul', archivePath, outSlash]]);
    }
    if (winrar) {
      attempts.push([winrar, ['x', '-ibck', '-y', archivePath, outSlash]]);
    }
  }
  if (sevenZip) {
    attempts.push([sevenZip, ['x', '-y', `-o${outDir}`, archivePath]]);
  }
  if (winrar) {
    attempts.push([winrar, ['x', '-ibck', '-y', archivePath, outSlash]]);
  }
  attempts.push(['tar.exe', ['-xf', archivePath, '-C', outDir]]);

  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 15000 });
      const found = findRomRecursive(outDir);
      if (found) {
        return {
          romName: path.basename(found),
          romBuffer: fs.readFileSync(found)
        };
      }
    } catch {}
  }
  return null;
}

export function extractRomFromFile(filePath) {
  const base = path.basename(filePath);
  if (isSupportedRomFile(base)) {
    return { romName: base, romBuffer: fs.readFileSync(filePath) };
  }
  const buf = fs.readFileSync(filePath);
  if (base.toLowerCase().endsWith('.zip')) {
    try {
      const zipRes = extractRomFromZipBuffer(buf);
      if (zipRes) return zipRes;
    } catch {}
  }
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_rom_ext_'));
  try {
    const res = extractArchiveToDir(filePath, tmpOut);
    if (res) return res;
  } finally {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }
  throw new Error(`No supported ROM found inside archive "${base}"`);
}

export function extractRomFromBuffer(buf, fileName = 'archive.zip') {
  const base = path.basename(fileName);
  if (isSupportedRomFile(base)) {
    return { romName: base, romBuffer: Buffer.from(buf) };
  }
  if (base.toLowerCase().endsWith('.zip') ||
      (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b)) {
    try {
      const zipRes = extractRomFromZipBuffer(buf);
      if (zipRes) return zipRes;
    } catch {}
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_arc_in_'));
  const ext = path.extname(base) || '.bin';
  const archivePath = path.join(tmpDir, `input${ext}`);
  const outDir = path.join(tmpDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    fs.writeFileSync(archivePath, buf);
    const res = extractArchiveToDir(archivePath, outDir);
    if (res) return res;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  throw new Error(`Unable to extract ROM from "${base}"`);
}

export function handleLocalRomsApi(res, rootDir, sendJson) {
  const localDir = path.join(rootDir, 'local');
  const files = fs.existsSync(localDir)
    ? fs.readdirSync(localDir).filter(isSupportedRomOrArchiveFile).sort()
    : [];
  sendJson(res, 200, { files });
}

export function handleLocalRomDownloadApi(urlObj, res, rootDir, sendJson) {
  const localDir = path.join(rootDir, 'local');
  let romFile = null;
  if (fs.existsSync(localDir)) {
    const files = fs.readdirSync(localDir).filter(isSupportedRomOrArchiveFile);
    const reqFile = urlObj.searchParams.get('file');
    if (reqFile && files.includes(reqFile)) {
      romFile = path.join(localDir, reqFile);
    } else if (files.length > 0) {
      romFile = path.join(localDir, files[0]);
    }
  }
  if (!romFile || !fs.existsSync(romFile)) {
    sendJson(res, 404, { available: false });
    return;
  }
  try {
    const { romName, romBuffer } = extractRomFromFile(romFile);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'X-Rom-Filename': encodeURIComponent(romName)
    });
    res.end(romBuffer);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
}

export function handleExtractRomPostApi(req, urlObj, res, sendJson) {
  const fileName = urlObj.searchParams.get('name') || 'archive.zip';
  const chunks = [];
  let total = 0;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > 32 * 1024 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      const buf = Buffer.concat(chunks);
      const { romName, romBuffer } = extractRomFromBuffer(buf, fileName);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'X-Rom-Filename': encodeURIComponent(romName)
      });
      res.end(romBuffer);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
  });
}
