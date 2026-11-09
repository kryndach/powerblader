// Server-Side ROM & Archive (.zip / .rar / .7z) Extractor & Local ROM API
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import {
  isSupportedRomFile, isArchiveFile, isSupportedRomOrArchiveFile
} from '../src/core_adapter.mjs';
import { computeRomCrc32 } from '../src/crc32.mjs';
import { cacheRoomRom } from './room_rom_and_save_api.mjs';

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
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

export function extractRomFromZipBuffer(buf) {
  const u8 = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (u8.length < 30 || u8.readUInt32LE(0) !== 0x04034b50) return null;

  let eocdOffset = -1;
  const minEocd = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= minEocd; i--) {
    if (u8.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
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
      if (baseName.toLowerCase().endsWith('.bin') && totalEntries > 1) continue;
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

function extractArchiveToDir(arc, outDir) {
  const lower = arc.toLowerCase();
  const winrar = findFirstExisting(WINRAR_PATHS);
  const unrar = findFirstExisting(UNRAR_PATHS);
  const sevenZip = findFirstExisting(SEVENZIP_PATHS);
  const outS = outDir + path.sep;
  const attempts = [];
  if (lower.endsWith('.rar')) {
    if (unrar) attempts.push([unrar, ['x', '-y', '-inul', arc, outS]]);
    if (winrar) attempts.push([winrar, ['x', '-ibck', '-y', arc, outS]]);
  }
  if (sevenZip) attempts.push([sevenZip, ['x', '-y', `-o${outDir}`, arc]]);
  if (winrar) attempts.push([winrar, ['x', '-ibck', '-y', arc, outS]]);
  attempts.push(['tar.exe', ['-xf', arc, '-C', outDir]]);

  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 15000 });
      const f = findRomRecursive(outDir);
      if (f) {
        return { romName: path.basename(f), romBuffer: fs.readFileSync(f) };
      }
    } catch {}
  }
  return null;
}

function parseZipEntries(u8) {
  if (!u8 || u8.length < 30 || u8.readUInt32LE(0) !== 0x04034b50) return null;
  let eocd = -1;
  const minPos = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= minPos; i--) {
    if (u8.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const total = u8.readUInt16LE(eocd + 10);
  let cdOff = u8.readUInt32LE(eocd + 16);
  const entries = [];
  for (let e = 0; e < total && cdOff + 46 <= u8.length; e++) {
    if (u8.readUInt32LE(cdOff) !== 0x02014b50) break;
    const compSize = u8.readUInt32LE(cdOff + 20);
    const nLen = u8.readUInt16LE(cdOff + 28);
    const xLen = u8.readUInt16LE(cdOff + 30);
    const cLen = u8.readUInt16LE(cdOff + 32);
    const lOff = u8.readUInt32LE(cdOff + 42);
    const cdLen = 46 + nLen + xLen + cLen;
    const name = u8.subarray(cdOff + 46, cdOff + 46 + nLen).toString('utf8');
    const lNameLen = u8.readUInt16LE(lOff + 26);
    const lExtraLen = u8.readUInt16LE(lOff + 28);
    const localTotal = 30 + lNameLen + lExtraLen + compSize;
    entries.push({
      name: name.toLowerCase(),
      localSlice: u8.subarray(lOff, lOff + localTotal),
      cdSlice: Buffer.from(u8.subarray(cdOff, cdOff + cdLen))
    });
    cdOff += cdLen;
  }
  return entries;
}

function mergeZipBuffers(childBuf, parentBuf) {
  const cEnts = parseZipEntries(childBuf);
  const pEnts = parseZipEntries(parentBuf);
  if (!cEnts || !pEnts) return childBuf;
  const seen = new Set(cEnts.map((e) => e.name));
  const merged = [...cEnts, ...pEnts.filter((e) => !seen.has(e.name))];
  if (merged.length === cEnts.length) return childBuf;
  const localParts = [];
  const cdParts = [];
  let offset = 0;
  for (const ent of merged) {
    const cd = Buffer.from(ent.cdSlice);
    cd.writeUInt32LE(offset, 42);
    localParts.push(ent.localSlice);
    cdParts.push(cd);
    offset += ent.localSlice.length;
  }
  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(merged.length, 8);
  eocd.writeUInt16LE(merged.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function mergeCompanionZipIfPresent(filePath, buf) {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  let out = buf;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.zip')) continue;
      const otherStem = path.basename(f, path.extname(f)).toLowerCase();
      if (otherStem === stem) continue;
      if (stem.startsWith(otherStem) || otherStem === 'neogeo' ||
          otherStem === 'pgm' || otherStem === 'ym2608') {
        const pBuf = fs.readFileSync(path.join(dir, f));
        out = mergeZipBuffers(out, pBuf);
      }
    }
  } catch {}
  return out;
}

export function extractRomFromFile(filePath) {
  const base = path.basename(filePath);
  if (isSupportedRomFile(base)) {
    return { romName: base, romBuffer: fs.readFileSync(filePath) };
  }
  const buf = fs.readFileSync(filePath);
  const isArcadeDir = filePath.replace(/\\/g, '/').includes('/arcade/');
  if (base.toLowerCase().endsWith('.zip')) {
    if (!isArcadeDir) {
      try {
        const zipRes = extractRomFromZipBuffer(buf);
        if (zipRes) return zipRes;
      } catch {}
    }
    if (buf.length >= 30 && buf.readUInt32LE(0) === 0x04034b50) {
      return {
        romName: base,
        romBuffer: mergeCompanionZipIfPresent(filePath, buf)
      };
    }
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
    if (buf.length >= 30 && buf[0] === 0x50 && buf[1] === 0x4b) {
      const arcPath = path.resolve('local', 'arcade', base);
      return {
        romName: base,
        romBuffer: Buffer.from(mergeCompanionZipIfPresent(arcPath, buf))
      };
    }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_arc_in_'));
  const archivePath = path.join(tmpDir, `input${path.extname(base) || '.bin'}`);
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

export function listLocalRomFiles(localDir) {
  if (!fs.existsSync(localDir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(localDir, { withFileTypes: true })) {
    if (ent.isFile() && isSupportedRomOrArchiveFile(ent.name)) {
      out.push(ent.name);
    } else if (ent.isDirectory()) {
      for (const s of fs.readdirSync(
        path.join(localDir, ent.name), { withFileTypes: true }
      )) {
        if (s.isFile() && isSupportedRomOrArchiveFile(s.name)) {
          out.push(`${ent.name}/${s.name}`);
        }
      }
    }
  }
  return out.sort();
}

function sendRomBuffer(req, res, romName, romBuffer) {
  const gzOk = /\bgzip\b/i.test(req?.headers?.['accept-encoding'] || '');
  const useGz = gzOk && !romName.toLowerCase().endsWith('.zip') &&
    romBuffer.length > 16384;
  const body = useGz ? zlib.gzipSync(romBuffer) : romBuffer;
  const hdrs = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    'X-Raw-Length': String(romBuffer.length),
    'X-Rom-Filename': encodeURIComponent(romName)
  };
  if (useGz) hdrs['Content-Encoding'] = 'gzip';
  res.writeHead(200, hdrs);
  res.end(body);
}

export function handleLocalRomsApi(res, rootDir, sendJson) {
  sendJson(res, 200, { files: listLocalRomFiles(path.join(rootDir, 'local')) });
}

export function handleLocalRomDownloadApi(
  req, urlObj, res, rootDir, sendJson
) {
  const localDir = path.join(rootDir, 'local');
  const files = listLocalRomFiles(localDir);
  const reqFile = (urlObj.searchParams.get('file') || '').replace(/\\/g, '/');
  const matched = reqFile
    ? files.find((f) => f === reqFile || path.posix.basename(f) === reqFile)
    : files[0] || null;
  const romFile = matched ? path.join(localDir, matched) : null;
  if (!romFile || !fs.existsSync(romFile)) {
    return sendJson(res, 404, { available: false });
  }
  try {
    const { romName, romBuffer } = extractRomFromFile(romFile);
    sendRomBuffer(req, res, romName, romBuffer);
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
    if (total > 64 * 1024 * 1024) return req.destroy();
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      const { romName, romBuffer } = extractRomFromBuffer(
        Buffer.concat(chunks), fileName
      );
      const crc = computeRomCrc32(romBuffer);
      cacheRoomRom(urlObj.searchParams.get('room'), crc, romName, romBuffer);
      sendRomBuffer(req, res, romName, romBuffer);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
  });
}
