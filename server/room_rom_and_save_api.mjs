// HTTP Room-ROM Range/Striped Cache (/api/room-rom) & Saves (/api/save-slot)
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const roomRomCache = new Map();
const pendingMultipart = new Map();

const cleanCrc = (raw) =>
  String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase().slice(0, 16);

const cleanRoom = (raw) =>
  String(raw || 'NOVA').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');

export function sendBinaryWithRange(
  req, res, rawBuf, gzBuf = null, extra = {}
) {
  const rawGz = req.headers['x-accept-raw-gz'] === '1' ||
    /[?&]rawgz=1\b/.test(req.url || '');
  const gzOk = /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
  const rangeHdr = req.headers.range || '';
  const m = /^bytes=(\d+)-(\d*)$/i.exec(rangeHdr.trim());
  const vary = 'Accept-Encoding, X-Accept-Raw-Gz';

  if (m) {
    const useGz = Boolean(rawGz && gzBuf);
    const src = useGz ? gzBuf : rawBuf;
    const start = Number(m[1]);
    const end = m[2] ? Math.min(src.length - 1, Number(m[2])) : src.length - 1;
    if (start >= src.length || start > end) {
      res.writeHead(416, {
        'Content-Range': `bytes */${src.length}`, Vary: vary
      });
      return res.end();
    }
    const slice = src.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${src.length}`,
      'Content-Length': String(slice.length),
      'X-Raw-Length': String(rawBuf.length),
      'X-Payload-Encoding': useGz ? 'gzip' : 'identity',
      Vary: vary,
      ...extra
    });
    return res.end(slice);
  }

  const useGz = Boolean(gzOk && gzBuf && !rawGz);
  const body = useGz ? gzBuf : (rawGz && gzBuf ? gzBuf : rawBuf);
  const hdrs = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(body.length),
    'X-Raw-Length': String(rawBuf.length),
    'X-Payload-Encoding': rawGz && gzBuf ? 'gzip' : 'identity',
    Vary: vary,
    ...extra
  };
  if (useGz) hdrs['Content-Encoding'] = 'gzip';
  res.writeHead(200, hdrs);
  res.end(body);
}

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
    const extra = {
      'X-Rom-Filename': encodeURIComponent(cached.romName),
      'X-Rom-Crc32': cached.crc || '',
      'Cache-Control': 'no-store'
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'X-Raw-Length': String(cached.romBuffer.length),
        ...extra
      });
      return res.end();
    }
    return sendBinaryWithRange(
      req, res, cached.romBuffer, cached.gzipBuffer, extra
    );
  }

  if (req.method === 'POST') {
    const romName = path.basename(
      urlObj.searchParams.get('name') || 'Game.nes'
    );
    const isGzipBody =
      req.headers['x-rom-encoding'] === 'gzip' ||
      /\bgzip\b/i.test(req.headers['content-encoding'] || '');
    const partIdx = Number(urlObj.searchParams.get('part'));
    const totalParts = Number(urlObj.searchParams.get('total') || '1');
    const offset = Number(urlObj.searchParams.get('offset') || '0');
    const fullSize = Number(urlObj.searchParams.get('size') || '0');

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
        if (totalParts > 1 && fullSize > 0 && Number.isInteger(partIdx)) {
          const key = `${roomCode}:${crc || romName}:${fullSize}`;
          let st = pendingMultipart.get(key);
          if (!st || Date.now() - st.ts > 300000) {
            st = {
              buf: Buffer.allocUnsafe(fullSize),
              seen: new Set(),
              ts: Date.now()
            };
            pendingMultipart.set(key, st);
          }
          st.ts = Date.now();
          if (offset + rawBody.length <= fullSize) {
            rawBody.copy(st.buf, offset);
            st.seen.add(partIdx);
          }
          if (st.seen.size < totalParts) {
            return sendJson(res, 200, {
              ok: true, complete: false, received: st.seen.size, totalParts
            }, true);
          }
          pendingMultipart.delete(key);
          const romBuf = isGzipBody ? zlib.gunzipSync(st.buf) : st.buf;
          const gzPart = isGzipBody ? st.buf : null;
          cacheRoomRom(roomCode, crc, romName, romBuf, gzPart);
          return sendJson(res, 200, {
            ok: true, complete: true, roomCode, crc, romName,
            size: romBuf.length
          }, true);
        }

        const romBuffer = isGzipBody ? zlib.gunzipSync(rawBody) : rawBody;
        const gzBuf = isGzipBody ? rawBody : null;
        cacheRoomRom(roomCode, crc, romName, romBuffer, gzBuf);
        sendJson(res, 200, {
          ok: true, complete: true, roomCode, crc, romName,
          size: romBuffer.length
        }, true);
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
          res, 200, { ok: true, savedTo: `local/saves/${fileName}`, slot }, true
        );
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }
  sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}
