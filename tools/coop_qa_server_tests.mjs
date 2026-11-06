/**
 * @fileoverview Server Handshake, Late-Join ROM Transfer & Bi-Directional ROM
 * Switch QA Tests (Tests 4 & 5).
 *
 * Line width <= 80 chars, file size <= 350 lines.
 */

import assert from 'assert';
import * as jsnesModule from 'jsnes';
import WebSocket from 'ws';
import {
  NesNetplayEngine,
  INPUT_BITS,
  computeDeterministicHash,
  computeRomCrc32
} from '../src/netplay_engine.mjs';
import { createCoopServer } from '../server/relay_server.mjs';
import { createDualControllerTestRom } from './test_rom_builder_tables.mjs';

const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;

function sendJsonWhenOpen(ws, obj) {
  const str = JSON.stringify(obj);
  if (ws.readyState === 1) ws.send(str);
  else ws.once('open', () => ws.send(str));
}

export async function runTest4LateJoinAndDesync() {
  const serverApp = createCoopServer({ logAccess: false });
  const port = await serverApp.listen(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const { uint8, binaryString } = createDualControllerTestRom(0);
  const romCrc = computeRomCrc32(uint8);

  const nesHost = new jsnes.NES({});
  nesHost.loadROM(binaryString);
  const engHost = new NesNetplayEngine(nesHost, {
    localPlayer: 1,
    online: false
  });
  for (let i = 0; i < 90; i++) {
    engHost.stepNetplayFrame(INPUT_BITS.RIGHT | INPUT_BITS.A, 0);
  }
  assert.strictEqual(engHost.currentFrame, 90);

  const wsSG = new WebSocket(wsUrl);
  const wsRU = new WebSocket(wsUrl);

  let ruSynced = false;
  let webrtcOfferRelayed = false;
  const nesClient = new jsnes.NES({});
  let engClient = null;

  await new Promise((resolve, reject) => {
    wsSG.on('open', () => {
      wsSG.send(
        JSON.stringify({
          type: 'join_room',
          roomCode: 'RETRO',
          nick: 'Egor-SG',
          romCrc32: romCrc,
          romName: 'TestCoop.nes'
        })
      );
    });

    wsSG.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'room_joined') {
        sendJsonWhenOpen(wsRU, {
          type: 'join_room',
          roomCode: 'RETRO',
          nick: 'Brother-RU',
          romCrc32: null,
          romName: null
        });
      } else if (msg.type === 'peer_joined') {
        const syncState = engHost.exportSyncState();
        const syncJsonSize = JSON.stringify(syncState).length;
        assert.ok(
          syncJsonSize < 550000,
          `Expected compact syncState (<550KB), got ${syncJsonSize} bytes`
        );
        engHost.online = true;
        engHost.importSyncState(syncState);
        wsSG.send(
          JSON.stringify({
            type: 'webrtc_signal',
            signal: { sdp: { type: 'offer', sdp: 'v=0-test-offer' } }
          })
        );
        wsSG.send(
          JSON.stringify({
            type: 'rom_sync',
            romName: 'TestCoop.nes',
            romCrc32: romCrc,
            romBase64: Buffer.from(uint8).toString('base64'),
            syncState
          })
        );
      }
    });

    wsRU.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'webrtc_signal' && msg.signal?.sdp?.type === 'offer') {
        webrtcOfferRelayed = true;
      } else if (msg.type === 'rom_sync') {
        const recvBytes = new Uint8Array(
          Buffer.from(msg.romBase64, 'base64')
        );
        let bin = '';
        for (let i = 0; i < recvBytes.length; i++) {
          bin += String.fromCharCode(recvBytes[i]);
        }
        nesClient.loadROM(bin);
        engClient = new NesNetplayEngine(nesClient, {
          localPlayer: 2,
          online: true
        });
        engClient.importSyncState(msg.syncState);
        ruSynced = true;
      }
      if (ruSynced && webrtcOfferRelayed) resolve();
    });

    wsSG.on('error', reject);
    wsRU.on('error', reject);
  });

  assert.ok(webrtcOfferRelayed, 'WebRTC signaling offer was not relayed');
  assert.ok(ruSynced && engClient, 'Late-join ROM + state sync failed');
  assert.strictEqual(engClient.currentFrame, 90);
  assert.strictEqual(
    computeDeterministicHash(nesClient),
    computeDeterministicHash(nesHost),
    'Client hash after late-join sync did not match Host'
  );

  nesClient.cpu.mem[0x0020] ^= 0xff;
  engHost.online = true;
  for (let f = 0; f < 35; f++) {
    const r1 = engHost.stepNetplayFrame(0);
    const r2 = engClient.stepNetplayFrame(0);
    if (r1.packetToSend) engClient.receiveRemoteInputPacket(r1.packetToSend);
    if (r2.packetToSend) engHost.receiveRemoteInputPacket(r2.packetToSend);
  }
  assert.strictEqual(
    engClient.syncStatus,
    'DESYNC',
    'Debug telemetry should detect intentional RAM corruption'
  );

  engClient.importSyncState(engHost.exportSyncState());
  assert.strictEqual(engClient.syncStatus, 'SYNC_OK');
  assert.strictEqual(
    computeDeterministicHash(nesClient),
    computeDeterministicHash(nesHost)
  );

  wsSG.close();
  wsRU.close();
  await serverApp.close();
  console.log(
    '[PASS] Test 4: Late-Join Auto ROM Transfer, Compact Snapshot ' +
      '& Desync Detection/Recovery Verified'
  );
}

export async function runTest5BiDirectionalRomSwitch() {
  const serverApp = createCoopServer({ logAccess: false });
  const port = await serverApp.listen(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const romP1Default = createDualControllerTestRom(4);
  const romP2Custom = createDualControllerTestRom(0);
  romP2Custom.uint8[romP2Custom.uint8.length - 1] ^= 0x5a;
  const crcP1 = computeRomCrc32(romP1Default.uint8);
  const crcP2 = computeRomCrc32(romP2Custom.uint8);
  assert.notStrictEqual(crcP1, crcP2);

  let nesP1 = new jsnes.NES({});
  nesP1.loadROM(romP1Default.binaryString);
  let engP1 = new NesNetplayEngine(nesP1, { localPlayer: 1, online: true });
  let p1RomName = 'Power Blade 2.nes';
  let p1Crc = crcP1;

  for (let i = 0; i < 120; i++) {
    engP1.stepNetplayFrame(INPUT_BITS.RIGHT);
  }

  const nesP2 = new jsnes.NES({});
  nesP2.loadROM(romP2Custom.binaryString);
  const engP2 = new NesNetplayEngine(nesP2, { localPlayer: 2, online: true });
  const p2RomName = 'Balloon Fight.nes';
  const p2Crc = crcP2;

  const ws1 = new WebSocket(wsUrl);
  const ws2 = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    let p1Ready = false;
    ws1.on('open', () => {
      ws1.send(
        JSON.stringify({
          type: 'join_room',
          roomCode: 'NOVA',
          nick: 'Brother-RU',
          romCrc32: p1Crc,
          romName: p1RomName,
          isAutoDefaultRom: true
        })
      );
    });

    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'room_joined' && !p1Ready) {
        p1Ready = true;
        sendJsonWhenOpen(ws2, {
          type: 'join_room',
          roomCode: 'NOVA',
          nick: 'Egor-SG',
          romCrc32: p2Crc,
          romName: p2RomName,
          isAutoDefaultRom: false
        });
      } else if (msg.type === 'rom_sync') {
        const u8 = new Uint8Array(Buffer.from(msg.romBase64, 'base64'));
        let bin = '';
        for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        p1RomName = msg.romName;
        p1Crc = msg.romCrc32;
        nesP1 = new jsnes.NES({});
        nesP1.loadROM(bin);
        engP1 = new NesNetplayEngine(nesP1, { localPlayer: 1, online: true });
        engP1.importSyncState(msg.syncState);
        engP1.syncPaused = false;
        ws1.send(
          JSON.stringify({
            type: 'sync_ack',
            sessionId: engP1.sessionId,
            frame: engP1.currentFrame,
            romCrc32: p1Crc
          })
        );
      }
    });

    ws2.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'room_joined') {
        const partner = msg.peers.find((p) => p.playerIndex === 1);
        assert.strictEqual(partner.isAutoDefaultRom, true);
        const sessionId = 'test_balloon_session';
        nesP2.loadROM(romP2Custom.binaryString);
        engP2.resetTimeline(0, sessionId);
        const syncState = engP2.exportSyncState();
        engP2.importSyncState(syncState);
        engP2.syncPaused = true;

        for (let t = 0; t < 10; t++) {
          const stepRes = engP2.stepNetplayFrame(INPUT_BITS.A);
          assert.strictEqual(stepRes.stepped, false);
        }
        assert.strictEqual(engP2.currentFrame, 0);

        ws2.send(
          JSON.stringify({
            type: 'rom_sync',
            romName: p2RomName,
            romCrc32: p2Crc,
            isAutoDefaultRom: false,
            romBase64: Buffer.from(romP2Custom.uint8).toString('base64'),
            syncState
          })
        );
      } else if (msg.type === 'sync_ack') {
        assert.strictEqual(msg.sessionId, engP2.sessionId);
        engP2.syncPaused = false;
        resolve();
      }
    });

    ws1.on('error', reject);
    ws2.on('error', reject);
  });

  assert.strictEqual(p1RomName, 'Balloon Fight.nes');
  assert.strictEqual(p2RomName, 'Balloon Fight.nes');
  assert.strictEqual(p1Crc, p2Crc);
  assert.strictEqual(engP1.currentFrame, 0);
  assert.strictEqual(engP2.currentFrame, 0);
  assert.strictEqual(engP1.sessionId, engP2.sessionId);
  assert.strictEqual(
    computeDeterministicHash(nesP1),
    computeDeterministicHash(nesP2)
  );

  const qTo1 = [];
  const qTo2 = [];
  for (let f = 0; f < 600; f++) {
    const now = f * 16.667;
    while (qTo1.length > 0 && qTo1[0].at <= now) {
      engP1.receiveRemoteInputPacket(qTo1.shift().pkt);
    }
    while (qTo2.length > 0 && qTo2[0].at <= now) {
      engP2.receiveRemoteInputPacket(qTo2.shift().pkt);
    }

    const m1 = (f % 15 < 7 ? INPUT_BITS.A : 0) | INPUT_BITS.RIGHT;
    const m2 = (f % 11 < 5 ? INPUT_BITS.B : 0) | INPUT_BITS.LEFT;
    const r1 = engP1.stepNetplayFrame(m1);
    const r2 = engP2.stepNetplayFrame(m2);
    if (r1.packetToSend) qTo2.push({ at: now + 90, pkt: r1.packetToSend });
    if (r2.packetToSend) qTo1.push({ at: now + 90, pkt: r2.packetToSend });
  }
  while (qTo1.length > 0) engP1.receiveRemoteInputPacket(qTo1.shift().pkt);
  while (qTo2.length > 0) engP2.receiveRemoteInputPacket(qTo2.shift().pkt);
  for (let s = 0; s < 12; s++) {
    const r1 = engP1.stepNetplayFrame(0);
    const r2 = engP2.stepNetplayFrame(0);
    if (r1.packetToSend) engP2.receiveRemoteInputPacket(r1.packetToSend);
    if (r2.packetToSend) engP1.receiveRemoteInputPacket(r2.packetToSend);
  }

  assert.strictEqual(engP1.desyncCount, 0);
  assert.strictEqual(engP2.desyncCount, 0);
  assert.strictEqual(
    computeDeterministicHash(nesP1),
    computeDeterministicHash(nesP2)
  );

  ws1.close();
  ws2.close();
  await serverApp.close();
  console.log(
    '[PASS] Test 5: Bi-Directional ROM Switch ' +
      '(Balloon Fight <-> Power Blade 2) & Lockstep sync_ack Verified'
  );
}
