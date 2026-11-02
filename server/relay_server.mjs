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
  // rooms: Map<roomCode, Map<clientId, PeerSession>>
  const rooms = new Map();
  const accessLog = [];

  function recordAccess(req, note) {
    const xff = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const host = req.headers['host'] || 'localhost';
    const ua = (req.headers['user-agent'] || '').slice(0, 65);
    const entry = {
      ts: new Date().toISOString().slice(11, 23),
      note,
      host,
      ip: String(xff).split(',')[0].trim(),
      ua
    };
    accessLog.push(entry);
    if (accessLog.length > 30) accessLog.shift();
    if (options.logAccess !== false) {
      console.log(`[${entry.ts}] ${note} | host=${host} | ip=${entry.ip}`);
    }
  }

  function getOrCreateRoom(roomCode) {
    if (!rooms.has(roomCode)) {
      rooms.set(roomCode, new Map());
    }
    return rooms.get(roomCode);
  }

  function getRoomPeersInfo(roomCode) {
    const roomMap = rooms.get(roomCode);
    if (!roomMap) return [];
    const peers = [];
    for (const peer of roomMap.values()) {
      peers.push({
        clientId: peer.clientId,
        playerIndex: peer.playerIndex,
        nick: peer.nick,
        romCrc32: peer.romCrc32,
        romName: peer.romName,
        isAutoDefaultRom: Boolean(peer.isAutoDefaultRom),
        wsOpen: Boolean(peer.ws && peer.ws.readyState === 1),
        httpActive: Boolean(peer.httpActive)
      });
    }
    return peers;
  }

  function sendToPeer(peer, payloadObj) {
    const seq = peer.nextSeq++;
    const msgWithSeq = { ...payloadObj, _seq: seq };
    const raw = JSON.stringify(msgWithSeq);

    if (peer.ws && peer.ws.readyState === 1) {
      try {
        peer.ws.send(raw);
      } catch {}
    }

    peer.httpOutbox.push(msgWithSeq);
    if (peer.httpOutbox.length > 400) {
      peer.httpOutbox.shift();
    }
  }

  function broadcastToRoom(roomCode, senderClientId, payloadObj) {
    const roomMap = rooms.get(roomCode);
    if (!roomMap) return;
    for (const peer of roomMap.values()) {
      if (peer.clientId !== senderClientId) {
        sendToPeer(peer, payloadObj);
      }
    }
  }

  function joinOrUpdatePeerSession(roomCodeRaw, clientIdRaw, info = {}, wsInstance = null) {
    const roomCode = String(roomCodeRaw || 'NOVA')
      .trim()
      .toUpperCase()
      .slice(0, 12);
    const clientId = String(clientIdRaw || `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const roomMap = getOrCreateRoom(roomCode);

    let peer = roomMap.get(clientId);
    const isNewJoin = !peer;

    if (!peer) {
      const usedIndices = new Set(Array.from(roomMap.values()).map((p) => p.playerIndex));
      const playerIndex = usedIndices.has(1) ? 2 : 1;
      peer = {
        clientId,
        roomCode,
        playerIndex,
        nick: String(info.nick || 'Player').slice(0, 20),
        romCrc32: info.romCrc32 || null,
        romName: info.romName || null,
        isAutoDefaultRom: typeof info.isAutoDefaultRom === 'boolean' ? info.isAutoDefaultRom : true,
        ws: wsInstance || null,
        httpActive: Boolean(info.httpActive),
        httpOutbox: [],
        nextSeq: 1,
        lastSeenAt: Date.now()
      };
      roomMap.set(clientId, peer);
    } else {
      peer.lastSeenAt = Date.now();
      if (info.nick) peer.nick = String(info.nick).slice(0, 20);
      if (info.romCrc32 !== undefined) peer.romCrc32 = info.romCrc32;
      if (info.romName !== undefined) peer.romName = info.romName;
      if (typeof info.isAutoDefaultRom === 'boolean') peer.isAutoDefaultRom = info.isAutoDefaultRom;
      if (wsInstance) peer.ws = wsInstance;
      if (info.httpActive) peer.httpActive = true;
    }

    const peers = getRoomPeersInfo(roomCode);

    if (isNewJoin || info.forceRoomJoined) {
      sendToPeer(peer, {
        type: 'room_joined',
        roomCode,
        clientId,
        playerIndex: peer.playerIndex,
        peers
      });

      broadcastToRoom(roomCode, clientId, {
        type: 'peer_joined',
        roomCode,
        peer: {
          clientId: peer.clientId,
          playerIndex: peer.playerIndex,
          nick: peer.nick,
          romCrc32: peer.romCrc32,
          romName: peer.romName,
          isAutoDefaultRom: Boolean(peer.isAutoDefaultRom),
          wsOpen: Boolean(peer.ws && peer.ws.readyState === 1),
          httpActive: Boolean(peer.httpActive)
        },
        peers
      });
    }

    return peer;
  }

  function handlePeerMessage(peer, msg) {
    if (!peer || !msg || typeof msg.type !== 'string') return;
    peer.lastSeenAt = Date.now();

    if (msg.type === 'ping') {
      sendToPeer(peer, { type: 'pong', t: msg.t, via: msg.via, serverTime: Date.now() });
      return;
    }

    if (msg.type === 'rom_info' || msg.type === 'rom_sync') {
      peer.romCrc32 = msg.romCrc32 || peer.romCrc32;
      peer.romName = msg.romName || peer.romName;
      if (typeof msg.isAutoDefaultRom === 'boolean') {
        peer.isAutoDefaultRom = msg.isAutoDefaultRom;
      }
    }

    const forwardTypes = new Set([
      'netplay_input',
      'state_sync',
      'sync_ack',
      'resync_request',
      'console_reset',
      'rom_info',
      'rom_request',
      'rom_sync',
      'webrtc_signal',
      'peer_ping',
      'peer_pong',
      'state',
      'event',
      'warp_request',
      'warp_snapshot'
    ]);

    if (forwardTypes.has(msg.type) || msg.type.startsWith('diag_')) {
      broadcastToRoom(peer.roomCode, peer.clientId, {
        ...msg,
        fromPlayer: peer.playerIndex,
        fromNick: peer.nick,
        serverRxTime: Date.now()
      });
    }
  }

  function removePeerSession(roomCode, clientId) {
    const roomMap = rooms.get(roomCode);
    if (!roomMap || !roomMap.has(clientId)) return;
    const removed = roomMap.get(clientId);
    roomMap.delete(clientId);
    if (roomMap.size === 0) {
      rooms.delete(roomCode);
    } else {
      broadcastToRoom(roomCode, clientId, {
        type: 'peer_left',
        playerIndex: removed.playerIndex,
        nick: removed.nick,
        peers: getRoomPeersInfo(roomCode)
      });
    }
  }

  // Cleanup stale HTTP-only sessions if neither WS is open nor HTTP polled for >12s
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [rc, roomMap] of rooms.entries()) {
      for (const [cid, peer] of roomMap.entries()) {
        const wsAlive = peer.ws && peer.ws.readyState === 1;
        if (!wsAlive && now - peer.lastSeenAt > 12000) {
          removePeerSession(rc, cid);
        }
      }
    }
  }, 3000);
  cleanupTimer.unref?.();

  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, activeRooms: rooms.size, accessLog }));
      return;
    }

    // Pure HTTPS Fetch Relay & Room Tunnel (Works even when ISP/Tunnel blocks WebSockets!)
    if (pathname === '/api/http-tunnel' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const roomCode = String(payload.roomCode || 'NOVA').trim().toUpperCase().slice(0, 12);
          const clientId = String(payload.clientId || '');
          if (!clientId) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Missing clientId' }));
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
            recordAccess(req, `HTTP_JOIN room=${roomCode} P${peer.playerIndex} (${peer.nick})`);
          }

          if (typeof payload.ackSeq === 'number') {
            peer.httpOutbox = peer.httpOutbox.filter((m) => m._seq > payload.ackSeq);
          }

          if (Array.isArray(payload.messages)) {
            for (const m of payload.messages) {
              handlePeerMessage(peer, m);
            }
          }

          const messages = peer.httpOutbox.slice(0, 120);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          res.end(
            JSON.stringify({
              ok: true,
              roomCode,
              playerIndex: peer.playerIndex,
              peers: getRoomPeersInfo(roomCode),
              messages,
              accessLog: accessLog.slice(-12),
              serverTime: Date.now()
            })
          );
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    if (pathname === '/api/local-roms') {
      const localDir = path.join(ROOT_DIR, 'local');
      let files = [];
      if (fs.existsSync(localDir)) {
        files = fs
          .readdirSync(localDir)
          .filter((f) => f.toLowerCase().endsWith('.nes'))
          .sort();
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ files }));
      return;
    }

    if (pathname === '/api/local-rom') {
      const localDir = path.join(ROOT_DIR, 'local');
      let romFile = null;
      if (fs.existsSync(localDir)) {
        const files = fs.readdirSync(localDir).filter((f) => f.toLowerCase().endsWith('.nes'));
        const requested = urlObj.searchParams.get('file');
        if (requested && files.includes(requested)) {
          romFile = path.join(localDir, requested);
        } else if (files.length > 0) {
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
      recordAccess(req, `PAGE_LOAD ${req.url}`);
      filePath = path.join(ROOT_DIR, 'public', 'index.html');
    } else if (pathname === '/nettest' || pathname === '/net_debug.html') {
      recordAccess(req, `NETTEST_LOAD ${req.url}`);
      filePath = path.join(ROOT_DIR, 'public', 'net_debug.html');
    } else if (pathname === '/src/netplay_engine.mjs') {
      filePath = path.join(ROOT_DIR, 'src', 'netplay_engine.mjs');
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

  // Allow up to 8 MB payloads for ROM / savestate transfers
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });

  wss.on('connection', (ws, req) => {
    recordAccess(req, 'WS_CONNECTED /ws');
    ws.peerSession = null;

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'ping' && !ws.peerSession) {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t, serverTime: Date.now() }));
        return;
      }

      if (msg.type === 'join_room') {
        const roomCode = String(msg.roomCode || 'NOVA')
          .trim()
          .toUpperCase()
          .slice(0, 12);
        const clientId = String(msg.clientId || `ws_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);

        if (ws.peerSession && ws.peerSession.roomCode !== roomCode) {
          removePeerSession(ws.peerSession.roomCode, ws.peerSession.clientId);
        }

        const peer = joinOrUpdatePeerSession(
          roomCode,
          clientId,
          {
            nick: msg.nick,
            romCrc32: msg.romCrc32,
            romName: msg.romName,
            isAutoDefaultRom: msg.isAutoDefaultRom,
            forceRoomJoined: true
          },
          ws
        );
        ws.peerSession = peer;
        recordAccess(req, `WS_JOIN room=${roomCode} P${peer.playerIndex} (${peer.nick})`);
        return;
      }

      if (ws.peerSession) {
        handlePeerMessage(ws.peerSession, msg);
      }
    });

    ws.on('close', () => {
      const peer = ws.peerSession;
      if (peer) {
        if (peer.ws === ws) {
          peer.ws = null;
        }
        // If this peer is not using the HTTP tunnel fallback, remove immediately
        if (!peer.httpActive) {
          removePeerSession(peer.roomCode, peer.clientId);
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
      clearInterval(cleanupTimer);
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
    console.log(`Universal NES Netplay Server listening on http://localhost:${actualPort}`);
    console.log(`2-PC Network & Protocol Diagnostic Tool: http://localhost:${actualPort}/nettest`);
    console.log(`WebSocket Relay & Signaling endpoint: ws://localhost:${actualPort}/ws`);
    console.log(`HTTPS Tunnel Fallback endpoint: http://localhost:${actualPort}/api/http-tunnel`);
    console.log(`For internet tunnel: ssh -R 80:127.0.0.1:${actualPort} nokey@localhost.run`);
  });
}
