import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

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

export function createCoopServer(options = {}) {
  const rooms = new Map(); // roomCode -> Set<ws>

  function broadcastToRoom(roomCode, senderWs, payloadObj) {
    const set = rooms.get(roomCode);
    if (!set) return;
    const raw = JSON.stringify(payloadObj);
    for (const client of set) {
      if (client !== senderWs && client.readyState === 1) {
        client.send(raw);
      }
    }
  }

  function getRoomPeersInfo(roomCode) {
    const set = rooms.get(roomCode);
    if (!set) return [];
    const peers = [];
    for (const client of set) {
      peers.push({
        playerIndex: client.playerIndex,
        nick: client.nick,
        romCrc32: client.romCrc32
      });
    }
    return peers;
  }

  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, activeRooms: rooms.size }));
      return;
    }

    if (pathname === '/api/local-rom') {
      const localDir = path.join(ROOT_DIR, 'local');
      let romFile = null;
      if (fs.existsSync(localDir)) {
        const files = fs.readdirSync(localDir).filter((f) => f.toLowerCase().endsWith('.nes'));
        if (files.length > 0) {
          romFile = path.join(localDir, files[0]);
        }
      }
      if (!romFile || !fs.existsSync(romFile)) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ available: false }));
        return;
      }
      const data = fs.readFileSync(romFile);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'X-Rom-Filename': encodeURIComponent(path.basename(romFile))
      });
      res.end(data);
      return;
    }

    if (pathname === '/vendor/jsnes.js') {
      const jsnesPath = path.join(ROOT_DIR, 'node_modules', 'jsnes', 'dist', 'jsnes.js');
      if (!fs.existsSync(jsnesPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const rawJsnes = fs.readFileSync(jsnesPath, 'utf8');
      const patchedJsnes = rawJsnes.replace('topTileNum - 1 + 256', 'topTileNum + 256');
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.js'] });
      res.end(patchedJsnes);
      return;
    }

    let filePath = null;
    if (pathname === '/' || pathname === '/index.html') {
      filePath = path.join(ROOT_DIR, 'public', 'index.html');
    } else if (pathname === '/src/coop_core.mjs') {
      filePath = path.join(ROOT_DIR, 'src', 'coop_core.mjs');
    } else if (pathname === '/games/power-blade-2/profile.json') {
      filePath = path.join(ROOT_DIR, 'games', 'power-blade-2', 'profile.json');
    }

    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.roomCode = null;
    ws.playerIndex = 1;
    ws.nick = 'Player';
    ws.romCrc32 = null;

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t, serverTime: Date.now() }));
        return;
      }

      if (msg.type === 'join_room') {
        const roomCode = String(msg.roomCode || 'NOVA')
          .trim()
          .toUpperCase()
          .slice(0, 12);
        ws.nick = String(msg.nick || 'Player').slice(0, 20);
        ws.romCrc32 = msg.romCrc32 || null;

        if (ws.roomCode && rooms.has(ws.roomCode)) {
          rooms.get(ws.roomCode).delete(ws);
        }

        if (!rooms.has(roomCode)) {
          rooms.set(roomCode, new Set());
        }
        const roomSet = rooms.get(roomCode);
        const usedIndices = new Set(Array.from(roomSet).map((c) => c.playerIndex));
        ws.playerIndex = usedIndices.has(1) ? 2 : 1;
        ws.roomCode = roomCode;
        roomSet.add(ws);

        const peers = getRoomPeersInfo(roomCode);
        ws.send(
          JSON.stringify({
            type: 'room_joined',
            roomCode,
            playerIndex: ws.playerIndex,
            peers
          })
        );

        broadcastToRoom(roomCode, ws, {
          type: 'peer_joined',
          roomCode,
          peer: {
            playerIndex: ws.playerIndex,
            nick: ws.nick,
            romCrc32: ws.romCrc32
          },
          peers
        });
        return;
      }

      if (!ws.roomCode) return;

      if (
        msg.type === 'state' ||
        msg.type === 'event' ||
        msg.type === 'warp_request' ||
        msg.type === 'warp_snapshot'
      ) {
        broadcastToRoom(ws.roomCode, ws, {
          ...msg,
          fromPlayer: ws.playerIndex,
          fromNick: ws.nick
        });
      }
    });

    ws.on('close', () => {
      const rc = ws.roomCode;
      if (rc && rooms.has(rc)) {
        const set = rooms.get(rc);
        set.delete(ws);
        if (set.size === 0) {
          rooms.delete(rc);
        } else {
          broadcastToRoom(rc, ws, {
            type: 'peer_left',
            playerIndex: ws.playerIndex,
            nick: ws.nick,
            peers: getRoomPeersInfo(rc)
          });
        }
      }
    });
  });

  return {
    server,
    wss,
    rooms,
    listen(port = 8080, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        const onListening = () => {
          const addr = server.address();
          resolve(addr.port);
        };
        if (host) {
          server.listen(port, host, onListening);
        } else {
          // Listen on dual-stack (:: and 0.0.0.0) so both IPv6 localhost (::1) and IPv4 (127.0.0.1) tunnels work on Windows
          server.listen(port, onListening);
        }
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => {
          server.close(() => resolve());
        });
      });
    }
  };
}

// Run directly if invoked as main script
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 8080);
  const app = createCoopServer();
  app.listen(port).then((actualPort) => {
    console.log(`Power Blade 2 Co-op Server listening on http://localhost:${actualPort}`);
    console.log(`WebSocket Relay endpoint: ws://localhost:${actualPort}/ws (or wss:// over TLS 443)`);
  });
}
