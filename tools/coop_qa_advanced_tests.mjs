/**
 * @fileoverview CHR-RAM Dirty-Tile Epochs, GGPO Clock-Rift Pacing,
 * Zero-Transfer Lockstep & Live Telemetry QA Test (Test 6).
 *
 * Line width <= 80 chars, file size <= 350 lines.
 */

import assert from 'assert';
import http from 'http';
import zlib from 'zlib';
import * as jsnesModule from 'jsnes';
import WebSocket from 'ws';
import {
  NesNetplayEngine,
  INPUT_BITS,
  computeRomCrc32,
  loadFastState
} from '../src/netplay_engine.mjs';
import { createCoopServer } from '../server/relay_server.mjs';
import { extractRomFromZipBuffer } from '../server/archive_extractor.mjs';
import { extractRomFromZipBrowser } from '../public/js/rom_archive.mjs';
import { formatKeyCode } from '../public/js/key_bindings.mjs';
import { createDualControllerTestRom } from './test_rom_builder_tables.mjs';

const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;

function httpJson(port, reqPath, method = 'GET', bodyObj = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: bodyStr
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr)
            }
          : {}
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export async function runTest6ChrRamRiftAndTelemetry() {
  // 6A: Verify CHR-RAM dirty-tile epoch tracking + fast savestates
  const chrRamRom = createDualControllerTestRom(2);
  const nesChr = new jsnes.NES({});
  nesChr.loadROM(chrRamRom.binaryString);
  const engChr = new NesNetplayEngine(nesChr, {
    localPlayer: 1,
    online: true
  });

  const initialEpoch = nesChr.ppu._nextTileEpoch;
  nesChr.ppu.patternWrite(0x0010, 0xaa);
  assert.ok(nesChr.ppu._nextTileEpoch > initialEpoch);
  assert.strictEqual(
    nesChr.ppu.ptTile[1]._tileEpoch,
    nesChr.ppu._nextTileEpoch
  );

  engChr.stepNetplayFrame(INPUT_BITS.A);
  const savedPixVal = nesChr.ppu.ptTile[1].pix[0];

  nesChr.ppu.patternWrite(0x0010, 0x55);
  const mutatedPixVal = nesChr.ppu.ptTile[1].pix[0];
  assert.notStrictEqual(mutatedPixVal, savedPixVal);
  engChr.stepNetplayFrame(INPUT_BITS.B);

  const slot0 = engChr.saveRing[0];
  assert.strictEqual(slot0.frame, 0);
  loadFastState(nesChr, slot0);
  assert.strictEqual(nesChr.ppu.ptTile[1].pix[0], savedPixVal);

  const slot1 = engChr.saveRing[1];
  assert.strictEqual(slot1.frame, 1);
  loadFastState(nesChr, slot1);
  assert.strictEqual(nesChr.ppu.ptTile[1].pix[0], mutatedPixVal);

  // 6A-2: Verify fast cached setMirroring & Auto (RTT) input delay
  nesChr.ppu.setMirroring(nesChr.rom.SINGLESCREEN_MIRRORING);
  assert.strictEqual(nesChr.ppu.ntable1[1], 0);
  assert.strictEqual(nesChr.ppu.vramMirrorTable[0x2400], 0x2000);
  nesChr.ppu.setMirroring(nesChr.rom.SINGLESCREEN_MIRRORING2);
  assert.strictEqual(nesChr.ppu.ntable1[1], 1);
  assert.strictEqual(nesChr.ppu.vramMirrorTable[0x2400], 0x2400);
  nesChr.ppu.setMirroring(nesChr.rom.SINGLESCREEN_MIRRORING);
  assert.strictEqual(nesChr.ppu.ntable1[1], 0);
  assert.ok(nesChr.ppu._mirrorCache.size >= 2);

  assert.strictEqual(NesNetplayEngine.computeRecommendedInputDelay(60, 5), 2);
  assert.strictEqual(
    NesNetplayEngine.computeRecommendedInputDelay(140, 10),
    3
  );
  assert.strictEqual(
    NesNetplayEngine.computeRecommendedInputDelay(225, 20),
    4
  );
  assert.strictEqual(
    NesNetplayEngine.computeRecommendedInputDelay(310, 30),
    5
  );

  // 6B: Verify GGPO Clock-Rift Pacing + RLE tail-trimmed packets
  const nes1 = new jsnes.NES({});
  const nes2 = new jsnes.NES({});
  nes1.loadROM(chrRamRom.binaryString);
  nes2.loadROM(chrRamRom.binaryString);
  const eng1 = new NesNetplayEngine(nes1, {
    localPlayer: 1,
    online: true,
    inputDelayFrames: 3,
    enableRiftPacing: true
  });
  const eng2 = new NesNetplayEngine(nes2, {
    localPlayer: 2,
    online: true,
    inputDelayFrames: 3,
    enableRiftPacing: true
  });

  const q12 = [];
  const q21 = [];
  for (let f = 0; f < 8; f++) {
    const r1 = eng1.stepNetplayFrame(INPUT_BITS.RIGHT);
    if (r1.packetToSend) {
      if (f === 7) {
        assert.strictEqual(r1.packetToSend.inputs.length, 9);
        assert.strictEqual(r1.packetToSend.tailCount, 11);
      }
      q12.push({ at: f * 16.667 + 110, pkt: r1.packetToSend });
    }
  }
  let checkedSteadySingleInputRle = false;
  for (let tick = 8; tick < 450; tick++) {
    const now = tick * 16.667;
    while (q12.length > 0 && q12[0].at <= now) {
      eng2.receiveRemoteInputPacket(q12.shift().pkt);
    }
    while (q21.length > 0 && q21[0].at <= now) {
      eng1.receiveRemoteInputPacket(q21.shift().pkt);
    }

    const r1 = eng1.stepNetplayFrame(INPUT_BITS.RIGHT);
    const r2 = eng2.stepNetplayFrame(INPUT_BITS.LEFT);
    if (r1.packetToSend) {
      if (tick >= 50 && !checkedSteadySingleInputRle) {
        assert.strictEqual(r1.packetToSend.inputs.length, 1);
        assert.ok(
          r1.packetToSend.tailCount >= 4 && r1.packetToSend.tailCount <= 32
        );
        checkedSteadySingleInputRle = true;
      }
      q12.push({ at: now + 110, pkt: r1.packetToSend });
    }
    if (r2.packetToSend) q21.push({ at: now + 110, pkt: r2.packetToSend });
  }
  assert.ok(checkedSteadySingleInputRle);
  const tel1 = eng1.getTelemetry();
  assert.ok(tel1.riftWaitFrames >= 5);
  assert.ok(Math.abs(eng1.currentFrame - eng2.currentFrame) <= 3);
  assert.strictEqual(tel1.desyncCount, 0);
  assert.strictEqual(eng2.getTelemetry().desyncCount, 0);

  // 6C: Verify Zero-Transfer `rom_status` + `match_start_req`/`ack` & Telemetry
  const serverApp = createCoopServer({ logAccess: false });
  const port = await serverApp.listen(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const tunJson = await httpJson(port, '/api/tunnel-info', 'POST', {
    tunnel: 'pinggy',
    region: 'eu',
    publicUrl: 'https://test-eu.a.pinggy.link'
  });
  assert.strictEqual(tunJson.tunnelInfo.region, 'eu');

  const wsA = new WebSocket(wsUrl);
  const wsB = new WebSocket(wsUrl);
  const sharedCrc = computeRomCrc32(chrRamRom.uint8);

  await new Promise((resolve, reject) => {
    wsA.on('open', () => {
      wsA.send(
        JSON.stringify({
          type: 'join_room',
          roomCode: 'BTDD',
          nick: 'Host-SG',
          romCrc32: null,
          romName: null
        })
      );
    });
    wsA.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'room_joined') {
        wsB.send(
          JSON.stringify({
            type: 'join_room',
            roomCode: 'BTDD',
            nick: 'Bro-Omsk',
            romCrc32: null,
            romName: null
          })
        );
      } else if (msg.type === 'peer_joined') {
        wsA.send(
          JSON.stringify({
            type: 'rom_status',
            romName: 'Battletoads & Double Dragon.nes',
            romCrc32: sharedCrc
          })
        );
        wsB.send(
          JSON.stringify({
            type: 'rom_status',
            romName: 'Battletoads & Double Dragon.nes',
            romCrc32: sharedCrc
          })
        );
      } else if (msg.type === 'rom_status' && msg.romCrc32 === sharedCrc) {
        wsA.send(
          JSON.stringify({
            type: 'match_start_req',
            sessionId: 'btdd_lockstep_01',
            romName: 'Battletoads & Double Dragon.nes',
            romCrc32: sharedCrc
          })
        );
      } else if (
        msg.type === 'match_start_ack' &&
        msg.sessionId === 'btdd_lockstep_01'
      ) {
        wsA.send(
          JSON.stringify({
            type: 'gameplay_telemetry_ws',
            telemetry: {
              role: 'pc1',
              roomCode: 'BTDD',
              playerIndex: 1,
              transport: 'WSS Relay',
              romName: 'Battletoads & Double Dragon.nes',
              romCrc32: sharedCrc,
              partnerRomCrc32: sharedCrc,
              matchState: 'RUNNING',
              currentFrame: 360,
              lastVerifiedFrame: 355,
              syncStatus: 'SYNC_OK',
              desyncCount: 0,
              rttMs: 220,
              jitterMs: 12,
              riftFrames: 0.4,
              inputDelayFrames: 3,
              fps: 60,
              lastStepMs: 1.8,
              rollbacksPerSec: 2,
              rollbacksTotal: 14,
              lastRollbackDepth: 2,
              maxRollbackDepthSeen: 4,
              frameAdvantage: 0.5,
              stallFrames: 0,
              riftWaitFrames: 8,
              txPerSec: 60,
              rxPerSec: 60,
              maxRxGapMs: 38,
              samples: [],
              events: ['[12:00:00] Lockstep Frame #0 started']
            }
          })
        );
        resolve();
      }
    });

    wsB.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'match_start_req' && msg.romCrc32 === sharedCrc) {
        wsB.send(
          JSON.stringify({
            type: 'match_start_ack',
            sessionId: msg.sessionId,
            romCrc32: sharedCrc
          })
        );
      }
    });

    wsA.on('error', reject);
    wsB.on('error', reject);
  });

  await new Promise((r) => setTimeout(r, 30));
  const getTelJson = await httpJson(port, '/api/gameplay-telemetry', 'GET');
  assert.strictEqual(getTelJson.session.tunnelInfo.region, 'eu');
  assert.strictEqual(
    getTelJson.session.pc1.romName,
    'Battletoads & Double Dragon.nes'
  );
  assert.ok(getTelJson.session.combinedText.includes('Region: eu'));

  // Verify ZIP ROM extraction (server + browser) & Key Binding formatting
  const nameBuf = Buffer.from('Folder/TestGame.nes');
  const compData = zlib.deflateRawSync(chrRamRom.uint8);
  const localHdr = Buffer.alloc(30);
  localHdr.writeUInt32LE(0x04034b50, 0);
  localHdr.writeUInt16LE(8, 8);
  localHdr.writeUInt32LE(compData.length, 18);
  localHdr.writeUInt16LE(nameBuf.length, 26);
  const cdHdr = Buffer.alloc(46);
  cdHdr.writeUInt32LE(0x02014b50, 0);
  cdHdr.writeUInt16LE(8, 10);
  cdHdr.writeUInt32LE(compData.length, 20);
  cdHdr.writeUInt16LE(nameBuf.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(30 + nameBuf.length + compData.length, 16);
  const zipBuf = Buffer.concat([
    localHdr, nameBuf, compData, cdHdr, nameBuf, eocd
  ]);
  const srvZip = extractRomFromZipBuffer(zipBuf);
  const brwZip = await extractRomFromZipBrowser(new Uint8Array(zipBuf));
  assert.strictEqual(srvZip.romName, 'TestGame.nes');
  assert.strictEqual(brwZip.romName, 'TestGame.nes');
  assert.strictEqual(computeRomCrc32(srvZip.romBuffer), sharedCrc);
  assert.strictEqual(computeRomCrc32(brwZip.romUint8), sharedCrc);
  assert.strictEqual(formatKeyCode('KeyZ'), 'Z');

  wsA.close();
  wsB.close();
  await serverApp.close();
  console.log('[PASS] Test 6: CHR-RAM, Clock-Rift, ZIP & Telemetry Verified');
}
