// Encrypted Zero-Link P2P Rendezvous Beacon (Nostr Port-443 Replaceable Events)
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import {
  deriveRendezvousKeys, createSignedBeaconEvent
} from './nostr_crypto.mjs';
import {
  normalizeRoomCode, deriveRoomSecret, deriveRoomAuthToken
} from '../src/room_auth.mjs';
import { isLocalHostRequest } from './tunnel_candidates.mjs';

export const DEFAULT_RENDEZVOUS_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social'
];

function loadOrCreateSecret(secretPath) {
  try {
    if (fs.existsSync(secretPath)) {
      const raw = fs.readFileSync(secretPath, 'utf8').trim();
      if (raw.length >= 8) return raw;
    }
  } catch {}
  const fresh = `nes_${crypto.randomBytes(12).toString('hex')}`;
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, `${fresh}\n`, 'utf8');
  } catch {}
  return fresh;
}

function publishEventToRelay(relayUrl, ev, timeoutMs = 4500) {
  return new Promise((resolve) => {
    let done = false;
    let ws = null;
    const finish = (ok, err = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.terminate?.(); } catch {}
      resolve({ relayUrl, ok, err });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    timer.unref?.();
    try {
      ws = new WebSocket(relayUrl, { handshakeTimeout: timeoutMs });
      ws.once('open', () => {
        try { ws.send(JSON.stringify(['EVENT', ev])); }
        catch (e) { finish(false, e.message); }
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg[0] === 'OK' && msg[1] === ev.id) {
            finish(Boolean(msg[2]), msg[3] || '');
          }
        } catch {}
      });
      ws.once('error', (e) => finish(false, e.message));
      ws.once('close', () => finish(false, 'closed'));
    } catch (e) {
      finish(false, e.message);
    }
  });
}

export function createRendezvousBeacon(rootDir, options = {}) {
  const isSilentTest = options.logAccess === false;
  const secretPath = options.secretPath || (
    isSilentTest ? null : path.join(rootDir, 'local', 'rendezvous_secret.txt')
  );
  const passPath = options.roomPasswordPath || (
    isSilentTest ? null : path.join(rootDir, 'local', 'room_password.txt')
  );
  const relays = Array.isArray(options.rendezvousRelays)
    ? options.rendezvousRelays : DEFAULT_RENDEZVOUS_RELAYS;
  const enabled = options.enableRendezvous !== false;
  const secret = options.rendezvousSecret || (
    secretPath
      ? loadOrCreateSecret(secretPath)
      : `nes_${crypto.randomBytes(12).toString('hex')}`
  );
  const keys = deriveRendezvousKeys(secret);
  let activeRoom = normalizeRoomCode(options.defaultRoom || 'NOVA');
  let roomPassword = String(
    options.roomPassword ?? process.env.NES_ROOM_PASSWORD ?? ''
  ).trim();
  if (!roomPassword && passPath && fs.existsSync(passPath)) {
    try { roomPassword = fs.readFileSync(passPath, 'utf8').trim(); } catch {}
  }
  let roomAuthToken = '';
  let passKeys = null;
  const syncPasswordDerived = async () => {
    const rs = deriveRoomSecret(activeRoom, roomPassword);
    passKeys = rs ? deriveRendezvousKeys(rs) : null;
    roomAuthToken = await deriveRoomAuthToken(activeRoom, roomPassword);
  };
  const initPromise = syncPasswordDerived().catch(() => {});

  const status = {
    enabled, okRelays: [], failRelays: [],
    lastPublishedAt: null, lastCandidateCount: 0
  };
  let lastTunnelInfo = null;
  let lastExtraCandidates = [];

  async function publishTunnelState(tunnelInfo, extraCandidates = []) {
    await initPromise;
    lastTunnelInfo = tunnelInfo;
    lastExtraCandidates = extraCandidates;
    if (!enabled || !tunnelInfo?.publicUrl || relays.length === 0) {
      return status;
    }
    const candidates = [];
    const pushUnique = (id, label, url) => {
      if (!url || candidates.some((c) => c.url === url)) return;
      candidates.push({ id, label, url });
    };
    const baseId = tunnelInfo.routeId || 'active';
    const baseLbl = tunnelInfo.routeLabel || 'Active';
    pushUnique(baseId, baseLbl, tunnelInfo.publicUrl);
    if (tunnelInfo.altUrl) {
      pushUnique(`${baseId}__alt`, `${baseLbl} (alt)`, tunnelInfo.altUrl);
    }
    for (const c of extraCandidates || []) {
      pushUnique(c.candId || c.id || 'cand', c.label || 'Alt', c.url);
    }
    const payload = {
      v: 1, room: activeRoom, ts: Date.now(),
      authRequired: Boolean(roomAuthToken), candidates
    };
    const evList = [createSignedBeaconEvent(payload, keys)];
    if (passKeys) evList.push(createSignedBeaconEvent(payload, passKeys));
    const allRes = await Promise.all(
      evList.flatMap((ev) =>
        relays.map((u) => publishEventToRelay(u, ev, options.relayTimeoutMs))
      )
    );
    const okSet = new Set(allRes.filter((r) => r.ok).map((r) => r.relayUrl));
    status.okRelays = [...okSet];
    status.failRelays = relays.filter((u) => !okSet.has(u));
    status.lastPublishedAt = new Date().toISOString();
    status.lastCandidateCount = candidates.length;
    return status;
  }

  async function setRoomPassword(room, password) {
    activeRoom = normalizeRoomCode(room || activeRoom);
    roomPassword = String(password || '').trim().slice(0, 64);
    if (passPath) {
      try {
        fs.mkdirSync(path.dirname(passPath), { recursive: true });
        if (roomPassword) {
          fs.writeFileSync(passPath, `${roomPassword}\n`, 'utf8');
        } else if (fs.existsSync(passPath)) fs.unlinkSync(passPath);
      } catch {}
    }
    await syncPasswordDerived();
    if (lastTunnelInfo?.publicUrl) {
      publishTunnelState(lastTunnelInfo, lastExtraCandidates).catch(() => {});
    }
    return getRoomAuthStatus();
  }

  function getRoomAuthStatus() {
    return {
      hasPassword: Boolean(roomPassword),
      room: activeRoom,
      authToken: roomAuthToken
    };
  }

  function buildStandaloneJoinHtml(roomCode = activeRoom) {
    const tmplPath = path.join(rootDir, 'public', 'join.html');
    const tmpl = fs.readFileSync(tmplPath, 'utf8');
    const safeRoom = normalizeRoomCode(roomCode || activeRoom);
    const cfg = {
      secret, pubkey: keys.pubkey, dTag: keys.dTag, room: safeRoom, relays
    };
    const safeJson = JSON.stringify(cfg).replace(/</g, '\\u003c');
    return tmpl.replace('/*__NES_JOIN_CONFIG__*/null', safeJson);
  }

  function handleRendezvousApi(req, urlObj, res, readJsonBody, sendJson) {
    if (!isLocalHostRequest(req)) {
      return sendJson(res, 403, { ok: false, error: 'Host-only API' }, true);
    }
    const p = urlObj.pathname;
    if (p === '/api/rendezvous-info' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true, pubkey: keys.pubkey, dTag: keys.dTag, relays, status,
        hasPassword: Boolean(roomPassword), authRoom: activeRoom
      }, true);
    }
    if (p === '/api/rendezvous-password' && req.method === 'POST') {
      readJsonBody(req, res, 4096, (body) => {
        setRoomPassword(body.room, body.password)
          .then((st) => sendJson(res, 200, { ok: true, ...st }, true))
          .catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
      });
      return;
    }
    if (p === '/api/join-file' && req.method === 'GET') {
      try {
        const html = buildStandaloneJoinHtml(urlObj.searchParams.get('room'));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="join_nes.html"',
          'Cache-Control': 'no-store'
        });
        res.end(html);
      } catch (e) { sendJson(res, 500, { ok: false, error: e.message }, true); }
      return;
    }
    if (p === '/api/rendezvous-publish' && req.method === 'POST') {
      publishTunnelState(lastTunnelInfo, lastExtraCandidates)
        .then((st) => sendJson(res, 200, { ok: true, status: st }, true))
        .catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
      return;
    }
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  return {
    keys, secret, relays, status, setRoomPassword, getRoomAuthStatus,
    publishTunnelState, buildStandaloneJoinHtml, handleRendezvousApi
  };
}
