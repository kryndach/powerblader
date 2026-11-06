// Universal NES Online Netplay HTTP & WebSocket Relay Server
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createSessionTrackers } from './report_formatters.mjs';
import { createRoomManager } from './room_manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.nes': 'application/octet-stream'
};

function sendJson(res, status, obj, noStore = false) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (noStore) headers['Cache-Control'] = 'no-store';
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

function readJsonBody(req, res, maxBytes, onParsed) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > maxBytes) req.destroy();
  });
  req.on('end', () => {
    try {
      onParsed(JSON.parse(body || '{}'));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
  });
}

function resolveStaticAsset(pathname, req, recordAccess) {
  if (pathname === '/' || pathname === '/index.html') {
    recordAccess(req, `PAGE_LOAD ${req.url}`);
    return path.join(ROOT_DIR, 'public', 'index.html');
  }
  if (pathname === '/nettest' || pathname === '/net_debug.html') {
    recordAccess(req, `NETTEST_LOAD ${req.url}`);
    return path.join(ROOT_DIR, 'public', 'net_debug.html');
  }
  if (pathname === '/autotest' || pathname === '/autotest.html') {
    recordAccess(req, `AUTOTEST_LOAD ${req.url}`);
    return path.join(ROOT_DIR, 'public', 'autotest.html');
  }
  if (pathname.startsWith('/src/') && pathname.endsWith('.mjs')) {
    return path.join(ROOT_DIR, 'src', path.basename(pathname));
  }
  if (pathname.startsWith('/css/') && pathname.endsWith('.css')) {
    return path.join(ROOT_DIR, 'public', 'css', path.basename(pathname));
  }
  if (pathname.startsWith('/js/') &&
      (pathname.endsWith('.mjs') || pathname.endsWith('.js'))) {
    return path.join(ROOT_DIR, 'public', 'js', path.basename(pathname));
  }
  return null;
}

export function createCoopServer(options = {}) {
  const trackers = createSessionTrackers(ROOT_DIR, options);
  const {
    accessLog, tunnelInfo, autotestSession, gameplayTelemetrySession,
    recordAccess, saveGameplayTelemetryToDisk, saveAutotestReportToDisk
  } = trackers;
  const roomMgr = createRoomManager(trackers, options);
  const {
    rooms, getOrCreateRoom, getRoomPeersInfo, joinOrUpdatePeerSession,
    handlePeerMessage, attachWebSocketServer, stopCleanup
  } = roomMgr;

  const server = http.createServer((req, res) => {
    const hostHdr = req.headers.host || 'localhost';
    const urlObj = new URL(req.url, `http://${hostHdr}`);
    const pathname = urlObj.pathname;

    if (pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true, activeRooms: rooms.size, tunnelInfo, accessLog
      });
      return;
    }

    if (pathname === '/api/tunnel-info') {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, tunnelInfo }, true);
        return;
      }
      if (req.method === 'POST') {
        readJsonBody(req, res, 64 * 1024, (parsed) => {
          if (parsed.tunnel) tunnelInfo.tunnel = String(parsed.tunnel);
          if (parsed.region) tunnelInfo.region = String(parsed.region);
          if (parsed.publicUrl !== undefined) {
            tunnelInfo.publicUrl = parsed.publicUrl;
          }
          tunnelInfo.updatedAt = new Date().toISOString();
          sendJson(res, 200, { ok: true, tunnelInfo });
        });
        return;
      }
    }

    if (pathname === '/api/gameplay-telemetry') {
      if (req.method === 'GET') {
        sendJson(
          res,
          200,
          { ok: true, session: gameplayTelemetrySession },
          true
        );
        return;
      }
      if (req.method === 'POST') {
        readJsonBody(req, res, 4 * 1024 * 1024, (telemetry) => {
          if (telemetry.playerIndex === 2) {
            gameplayTelemetrySession.pc2 = telemetry;
          } else {
            gameplayTelemetrySession.pc1 = telemetry;
          }
          saveGameplayTelemetryToDisk();
          sendJson(
            res,
            200,
            {
              ok: true,
              savedTo: 'logs/gameplay_telemetry_latest.txt',
              combinedText: gameplayTelemetrySession.combinedText
            },
            true
          );
        });
        return;
      }
    }

    if (pathname === '/api/autotest-report') {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, session: autotestSession }, true);
        return;
      }
      if (req.method === 'POST') {
        readJsonBody(req, res, 4 * 1024 * 1024, (report) => {
          if (report.playerIndex === 2) autotestSession.pc2 = report;
          else autotestSession.pc1 = report;
          saveAutotestReportToDisk();
          if (report.isFinal && options.logAccess !== false) {
            console.log(
              `[AUTOTEST] Saved final report from PC ${report.playerIndex}` +
                ' to logs/autotest_latest.txt'
            );
          }
          sendJson(
            res,
            200,
            {
              ok: true,
              savedTo: 'logs/autotest_latest.txt',
              combinedText: autotestSession.combinedText
            },
            true
          );
        });
        return;
      }
    }

    if (pathname === '/api/http-tunnel' && req.method === 'POST') {
      readJsonBody(req, res, 8 * 1024 * 1024, (payload) => {
        const roomCode = String(payload.roomCode || 'NOVA')
          .trim()
          .toUpperCase()
          .slice(0, 12);
        const clientId = String(payload.clientId || '');
        if (!clientId) {
          sendJson(res, 400, { ok: false, error: 'Missing clientId' });
          return;
        }

        const roomMap = getOrCreateRoom(roomCode);
        const existed = roomMap.has(clientId);
        const peer = joinOrUpdatePeerSession(
          roomCode,
          clientId,
          {
            nick: payload.nick,
            httpActive: true,
            forceRoomJoined: Boolean(payload.join)
          },
          null
        );

        if (!existed || payload.join) {
          recordAccess(
            req,
            `HTTP_JOIN room=${roomCode} P${peer.playerIndex} (${peer.nick})`
          );
        }

        if (typeof payload.ackSeq === 'number') {
          peer.httpOutbox = peer.httpOutbox.filter(
            (m) => m._seq > payload.ackSeq
          );
        }

        for (const m of payload.messages || []) handlePeerMessage(peer, m);

        sendJson(
          res,
          200,
          {
            ok: true,
            roomCode,
            playerIndex: peer.playerIndex,
            peers: getRoomPeersInfo(roomCode),
            messages: peer.httpOutbox.slice(0, 120),
            accessLog: accessLog.slice(-12),
            serverTime: Date.now()
          },
          true
        );
      });
      return;
    }

    if (pathname === '/api/local-roms') {
      const localDir = path.join(ROOT_DIR, 'local');
      const files = fs.existsSync(localDir)
        ? fs
            .readdirSync(localDir)
            .filter((f) => f.toLowerCase().endsWith('.nes'))
            .sort()
        : [];
      sendJson(res, 200, { files });
      return;
    }

    if (pathname === '/api/local-rom') {
      const localDir = path.join(ROOT_DIR, 'local');
      let romFile = null;
      if (fs.existsSync(localDir)) {
        const files = fs
          .readdirSync(localDir)
          .filter((f) => f.toLowerCase().endsWith('.nes'));
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
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'X-Rom-Filename': encodeURIComponent(path.basename(romFile))
      });
      res.end(fs.readFileSync(romFile));
      return;
    }

    if (pathname === '/vendor/jsnes.js') {
      const jsnesPath = path.join(
        ROOT_DIR, 'node_modules', 'jsnes', 'dist', 'jsnes.js'
      );
      if (!fs.existsSync(jsnesPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const patchedJsnes = fs
        .readFileSync(jsnesPath, 'utf8')
        .replace('topTileNum - 1 + 256', 'topTileNum + 256');
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.js'] });
      res.end(patchedJsnes);
      return;
    }

    const filePath = resolveStaticAsset(pathname, req, recordAccess);
    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream'
    });
    fs.createReadStream(filePath).pipe(res);
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false
  });
  server.on('connection', (socket) => socket.setNoDelay(true));
  attachWebSocketServer(wss);

  return {
    server,
    wss,
    rooms,
    listen(port = 8080, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        const onListening = () => resolve(server.address().port);
        if (host) server.listen(port, host, onListening);
        else server.listen(port, onListening);
      });
    },
    close() {
      stopCleanup();
      return new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(() => resolve()));
      });
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 8080);
  const app = createCoopServer();
  app.listen(port).then((p) => {
    console.log(`Universal NES Netplay Server: http://localhost:${p}`);
    console.log(`2-PC Network Diagnostic Tool: http://localhost:${p}/nettest`);
    console.log(`2-PC AutoTest Suite:          http://localhost:${p}/autotest`);
    console.log(`WebSocket Relay endpoint:     ws://localhost:${p}/ws`);
    console.log(`HTTPS Tunnel Fallback:        http://localhost:${p}/api/http-tunnel`);
  });
}
