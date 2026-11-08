// HTTP Room-ROM Gzip Cache (/api/room-rom) & Disk Save Slots (/api/save-slot)
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const roomRomCache = new Map();

const cleanCrc = (raw) =>
  String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase().slice(0, 16);

const cleanRoom = (raw) =>
  String(raw || 'NOVA').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');

export function cacheRoomRom(
  roomCodeRaw, crcRaw, romName, romBuffer, preGzipBuf = null
) {
  const roomCode = cleanRoom(roomCodeRaw);
  const crc = cleanCrc(crcRaw);
  const isZip = String(romName).toLowerCase().endsWith('.zip');
  const gzipBuffer =
    preGzipBuf ||
    (!isZip && romBuffer.length > 16384
      ? zlib.gzipSync(romBuffer, { level: 1 })
      : null);
  const entry = {
    romName, crc, romBuffer, gzipBuffer, updatedAt: Date.now()
  };
  if (roomCode) roomRomCache.set(roomCode, entry);
  if (crc) roomRomCache.set(`CRC:${crc}`, entry);
  return entry;
}

export function handleRoomRomApi(req, urlObj, res, sendJson) {
  const roomCode = cleanRoom(urlObj.searchParams.get('room'));
  const crc = cleanCrc(urlObj.searchParams.get('crc'));
  if (req.method === 'GET' || req.method === 'HEAD') {
    const cached =
      (crc && roomRomCache.get(`CRC:${crc}`)) || roomRomCache.get(roomCode);
    if (!cached || !cached.romBuffer) {
      return sendJson(res, 404, { ok: false, error: 'No room ROM cached' });
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'X-Raw-Length': String(cached.romBuffer.length) });
      res.end();
      return;
    }
    const gzOk = /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
    const useGz = Boolean(gzOk && cached.gzipBuffer);
    const body = useGz ? cached.gzipBuffer : cached.romBuffer;
    const hdrs = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      'X-Raw-Length': String(cached.romBuffer.length),
      'X-Rom-Filename': encodeURIComponent(cached.romName),
      'Cache-Control': 'no-store'
    };
    if (useGz) hdrs['Content-Encoding'] = 'gzip';
    res.writeHead(200, hdrs);
    res.end(body);
    return;
  }

  if (req.method === 'POST') {
    const romName = path.basename(
      urlObj.searchParams.get('name') || 'Game.nes'
    );
    const isGzipBody =
      req.headers['x-rom-encoding'] === 'gzip' ||
      /\bgzip\b/i.test(req.headers['content-encoding'] || '');
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) return req.destroy();
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const rawBody = Buffer.concat(chunks);
        if (!rawBody.length) {
          return sendJson(res, 400, { ok: false, error: 'Empty ROM payload' });
        }
        const romBuffer = isGzipBody ? zlib.gunzipSync(rawBody) : rawBody;
        const gzBuf = isGzipBody ? rawBody : null;
        cacheRoomRom(roomCode, crc, romName, romBuffer, gzBuf);
        sendJson(
          res,
          200,
          { ok: true, roomCode, crc, romName, size: romBuffer.length },
          true
        );
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }
  sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}

export function handleSaveSlotApi(req, urlObj, res, rootDir, sendJson) {
  const savesDir = path.join(rootDir, 'local', 'saves');
  if (req.method === 'GET') {
    const crc = cleanCrc(urlObj.searchParams.get('crc'));
    const slotParam = urlObj.searchParams.get('slot');
    if (!crc) return sendJson(res, 400, { ok: false, error: 'Missing crc' });
    if (!slotParam) {
      const savedSlots = [];
      for (let s = 1; s <= 5; s++) {
        const f = path.join(savesDir, `${crc}_slot_${s}.json`);
        if (fs.existsSync(f)) savedSlots.push(s);
      }
      return sendJson(res, 200, { ok: true, crc, savedSlots }, true);
    }
    const slot = Math.max(1, Math.min(5, Number(slotParam) || 1));
    const filePath = path.join(savesDir, `${crc}_slot_${slot}.json`);
    if (!fs.existsSync(filePath)) {
      return sendJson(res, 404, { ok: false, error: 'Save slot empty' }, true);
    }
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return sendJson(res, 200, { ok: true, entry }, true);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message }, true);
    }
  }

  if (req.method === 'POST') {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 16 * 1024 * 1024) return req.destroy();
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const crc = cleanCrc(body.romCrc32 || body.entry?.romCrc32);
        const slot = Math.max(
          1,
          Math.min(5, Number(body.slot || body.entry?.slot) || 1)
        );
        if (!crc || !body.entry?.syncState) {
          return sendJson(res, 400, { ok: false, error: 'Invalid save data' });
        }
        fs.mkdirSync(savesDir, { recursive: true });
        const fileName = `${crc}_slot_${slot}.json`;
        fs.writeFileSync(
          path.join(savesDir, fileName),
          JSON.stringify(body.entry)
        );
        sendJson(
          res,
          200,
          { ok: true, savedTo: `local/saves/${fileName}`, slot },
          true
        );
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }
  sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}
