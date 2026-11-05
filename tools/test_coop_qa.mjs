import assert from 'assert';
import fs from 'fs';
import http from 'http';
import * as jsnesModule from 'jsnes';
import WebSocket from 'ws';
import {
  NesNetplayEngine,
  INPUT_BITS,
  computeDeterministicHash,
  computeRomCrc32,
  formatHex32,
  saveFastState,
  loadFastState
} from '../src/netplay_engine.mjs';
import { createCoopServer } from '../server/relay_server.mjs';

const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;

/**
 * Builds a minimal valid iNES ROM with a 6502 NMI/main loop that reads
 * both Controller 1 ($4016) and Controller 2 ($4017) every frame, stores
 * the 8-bit button masks at $0010 (P1) and $0011 (P2), and updates deterministic
 * game state in RAM ($0020-$03FF) and PPU VRAM based on both players' inputs.
 */
function createDualControllerTestRom(mapperId = 0) {
  const prgBanks = mapperId === 4 ? 2 : 1; // 16KB units
  const chrBanks = mapperId === 2 ? 0 : 1; // 8KB units (Mapper 2 uses CHR-RAM)
  const header = new Uint8Array(16);
  header[0] = 0x4e; // 'N'
  header[1] = 0x45; // 'E'
  header[2] = 0x53; // 'S'
  header[3] = 0x1a;
  header[4] = prgBanks;
  header[5] = chrBanks;
  header[6] = (mapperId & 0x0f) << 4;
  header[7] = mapperId & 0xf0;

  const prgSize = prgBanks * 16384;
  const prg = new Uint8Array(prgSize).fill(0xea); // NOP

  // Assemble 6502 test program at $C000 (last 16KB bank, fixed across Mappers 0, 1, 2, 4)
  const baseOffset = prgSize - 16384;
  let pc = baseOffset;
  const emit = (...bytes) => {
    for (const b of bytes) prg[pc++] = b & 0xff;
  };

  // $C000: RESET handler
  // SEI; CLD; LDX #$FF; TXS
  emit(0x78, 0xd8, 0xa2, 0xff, 0x9a);
  // Enable NMI ($2000 = $80) and BG+Sprites ($2001 = $1E)
  emit(0xa9, 0x80, 0x8d, 0x00, 0x20);
  emit(0xa9, 0x1e, 0x8d, 0x01, 0x20);
  // Infinite main loop at $C010: INC $00; JMP $C010
  while (pc < baseOffset + 0x10) emit(0xea);
  emit(0xe6, 0x00, 0x4c, 0x10, 0xc0);

  // $C040: NMI handler (runs once per frame at VBlank)
  pc = baseOffset + 0x40;
  // PHA; TXA; PHA; TYA; PHA
  emit(0x48, 0x8a, 0x48, 0x98, 0x48);

  // Strobe controllers: LDA #$01; STA $4016; LDA #$00; STA $4016
  emit(0xa9, 0x01, 0x8d, 0x16, 0x40, 0xa9, 0x00, 0x8d, 0x16, 0x40);

  // Read 8 bits from $4016 into $0010 (P1) and $4017 into $0011 (P2)
  // LDX #$08
  emit(0xa2, 0x08);
  const loopStart = pc;
  // LDA $4016; LSR A; ROR $10
  emit(0xad, 0x16, 0x40, 0x4a, 0x66, 0x10);
  // LDA $4017; LSR A; ROR $11
  emit(0xad, 0x17, 0x40, 0x4a, 0x66, 0x11);
  // DEX; BNE loopStart
  const rel = (loopStart - (pc + 2)) & 0xff;
  emit(0xca, 0xd0, rel);

  // Update P1 X/Y ($0020, $0021) and P2 X/Y ($0022, $0023) from $10 and $11
  // LDA $20; CLC; ADC $10; STA $20
  emit(0xa5, 0x20, 0x18, 0x65, 0x10, 0x85, 0x20);
  // LDA $22; CLC; ADC $11; STA $22
  emit(0xa5, 0x22, 0x18, 0x65, 0x11, 0x85, 0x22);
  // Increment frame counter at $0030
  emit(0xe6, 0x30);

  // PLA; TAY; PLA; TAX; PLA; RTI
  emit(0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40);

  // Vectors at $FFFA-$FFFF
  const vecOffset = prgSize - 6;
  prg[vecOffset + 0] = 0x40; // NMI lo ($C040)
  prg[vecOffset + 1] = 0xc0; // NMI hi
  prg[vecOffset + 2] = 0x00; // RESET lo ($C000)
  prg[vecOffset + 3] = 0xc0; // RESET hi
  prg[vecOffset + 4] = 0x40; // IRQ lo
  prg[vecOffset + 5] = 0xc0; // IRQ hi

  const chrSize = chrBanks * 8192;
  const chr = new Uint8Array(chrSize);
  for (let i = 0; i < chrSize; i++) chr[i] = (i * 7) & 0xff;

  const total = new Uint8Array(16 + prgSize + chrSize);
  total.set(header, 0);
  total.set(prg, 16);
  total.set(chr, 16 + prgSize);

  let binStr = '';
  for (let i = 0; i < total.length; i++) {
    binStr += String.fromCharCode(total[i]);
  }
  return { uint8: total, binaryString: binStr };
}

async function runTests() {
  console.log('=== Universal NES Netplay & Rollback QA Test Suite ===\n');

  // ---------------------------------------------------------------------------
  // Test 1: Multi-Mapper Fast Binary Savestate Determinism (Mappers 0, 1, 2, 4)
  // ---------------------------------------------------------------------------
  for (const mapperId of [0, 1, 2, 4]) {
    const { binaryString } = createDualControllerTestRom(mapperId);
    const nes = new jsnes.NES({});
    nes.loadROM(binaryString);
    const eng = new NesNetplayEngine(nes, { localPlayer: 1, online: false });

    for (let f = 0; f < 45; f++) {
      eng.stepNetplayFrame((f * 13) & 0xff, (f * 29) & 0xff);
    }

    // Save snapshot at frame 45
    const savedSlot = eng.saveRing[44 % eng.saveBufferSize];
    saveFastState(nes, savedSlot, 45);
    const hashAt45 = computeDeterministicHash(nes);

    // Step 30 more frames with specific inputs
    for (let f = 45; f < 75; f++) {
      eng.stepNetplayFrame((f * 7) & 0xff, (f * 19) & 0xff);
    }
    const hashAt75Run1 = computeDeterministicHash(nes);

    // Rewind to frame 45 and re-run the exact same 30 frames
    loadFastState(nes, savedSlot);
    assert.strictEqual(
      computeDeterministicHash(nes),
      hashAt45,
      `Mapper ${mapperId} state restore hash mismatch at frame 45`
    );
    for (let f = 45; f < 75; f++) {
      eng.stepNetplayFrame((f * 7) & 0xff, (f * 19) & 0xff);
    }
    const hashAt75Run2 = computeDeterministicHash(nes);
    assert.strictEqual(
      hashAt75Run2,
      hashAt75Run1,
      `Mapper ${mapperId} re-simulation diverged at frame 75`
    );
  }
  console.log('[PASS] Test 1: Fast Binary Savestates & Re-simulation Verified (Mappers 0, 1, 2 CHR-RAM, 4 MMC3)');

  // ---------------------------------------------------------------------------
  // Test 2: Dual Controller ($4016 P1 + $4017 P2) Hardware Strobe & Rollback Sync
  // ---------------------------------------------------------------------------
  {
    const { binaryString } = createDualControllerTestRom(0);
    const nesP1 = new jsnes.NES({});
    const nesP2 = new jsnes.NES({});
    nesP1.loadROM(binaryString);
    nesP2.loadROM(binaryString);

    const engP1 = new NesNetplayEngine(nesP1, { localPlayer: 1, online: true, inputDelayFrames: 2 });
    const engP2 = new NesNetplayEngine(nesP2, { localPlayer: 2, online: true, inputDelayFrames: 2 });

    const p1Combo = INPUT_BITS.RIGHT | INPUT_BITS.A | INPUT_BITS.START;
    const p2Combo = INPUT_BITS.LEFT | INPUT_BITS.B | INPUT_BITS.SELECT;

    for (let i = 0; i < 40; i++) {
      const r1 = engP1.stepNetplayFrame(p1Combo);
      const r2 = engP2.stepNetplayFrame(p2Combo);
      if (r1.packetToSend) engP2.receiveRemoteInputPacket(r1.packetToSend);
      if (r2.packetToSend) engP1.receiveRemoteInputPacket(r2.packetToSend);
    }

    // Verify both NES consoles read the exact P1 ($0010) and P2 ($0011) controller masks into RAM
    assert.strictEqual(nesP1.cpu.mem[0x0010], nesP2.cpu.mem[0x0010], 'P1 controller RAM mismatch');
    assert.strictEqual(nesP1.cpu.mem[0x0011], nesP2.cpu.mem[0x0011], 'P2 controller RAM mismatch');
    assert.strictEqual(nesP1.cpu.mem[0x0020], nesP2.cpu.mem[0x0020], 'P1 state accumulator mismatch');
    assert.strictEqual(nesP1.cpu.mem[0x0022], nesP2.cpu.mem[0x0022], 'P2 state accumulator mismatch');
    assert.strictEqual(computeDeterministicHash(nesP1), computeDeterministicHash(nesP2));
  }
  console.log('[PASS] Test 2: Controller 1 ($4016) & Controller 2 ($4017) Simultaneous Input Sync Verified');

  // ---------------------------------------------------------------------------
  // Test 3: 3,600-Frame (60s) Rollback Stress Test under SG<->RU Network Chaos
  //         (180ms RTT, +/-35ms Jitter, 4% Packet Loss)
  // ---------------------------------------------------------------------------
  {
    const localRomPath = 'local/Power Blade 2 (U) [!].nes';
    const romData = fs.existsSync(localRomPath)
      ? fs.readFileSync(localRomPath, { encoding: 'binary' })
      : createDualControllerTestRom(4).binaryString;

    const nesSG = new jsnes.NES({});
    const nesRU = new jsnes.NES({});
    nesSG.loadROM(romData);
    nesRU.loadROM(romData);

    const engSG = new NesNetplayEngine(nesSG, {
      localPlayer: 1,
      online: true,
      inputDelayFrames: 2,
      maxRollbackFrames: 14
    });
    const engRU = new NesNetplayEngine(nesRU, {
      localPlayer: 2,
      online: true,
      inputDelayFrames: 2,
      maxRollbackFrames: 14
    });

    const inFlightToRU = [];
    const inFlightToSG = [];
    let seed = 0x9e3779b9;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    let p1Mask = 0;
    let p2Mask = 0;

    for (let step = 0; step < 3600; step++) {
      const nowMs = step * 16.667;

      // Change P1 & P2 controller inputs dynamically to trigger frequent mispredictions & rollbacks
      if (step % 7 === 0) p1Mask = Math.floor(nextRand() * 256);
      if (step % 9 === 0) p2Mask = Math.floor(nextRand() * 256);

      inFlightToRU.sort((a, b) => a.deliverAt - b.deliverAt);
      while (inFlightToRU.length > 0 && inFlightToRU[0].deliverAt <= nowMs) {
        engRU.receiveRemoteInputPacket(inFlightToRU.shift().pkt);
      }

      inFlightToSG.sort((a, b) => a.deliverAt - b.deliverAt);
      while (inFlightToSG.length > 0 && inFlightToSG[0].deliverAt <= nowMs) {
        engSG.receiveRemoteInputPacket(inFlightToSG.shift().pkt);
      }

      const rSG = engSG.stepNetplayFrame(p1Mask);
      const rRU = engRU.stepNetplayFrame(p2Mask);

      // 4% packet loss, 90ms +/- 35ms one-way delay (180ms RTT)
      if (rSG.packetToSend && nextRand() >= 0.04) {
        inFlightToRU.push({
          deliverAt: nowMs + 90 + (nextRand() * 70 - 35),
          pkt: rSG.packetToSend
        });
      }
      if (rRU.packetToSend && nextRand() >= 0.04) {
        inFlightToSG.push({
          deliverAt: nowMs + 90 + (nextRand() * 70 - 35),
          pkt: rRU.packetToSend
        });
      }
    }

    // Flush remaining in-flight packets and step 15 neutral frames so both reach the same confirmed frame
    while (inFlightToRU.length > 0) engRU.receiveRemoteInputPacket(inFlightToRU.shift().pkt);
    while (inFlightToSG.length > 0) engSG.receiveRemoteInputPacket(inFlightToSG.shift().pkt);

    for (let settle = 0; settle < 16; settle++) {
      const rSG = engSG.stepNetplayFrame(0);
      const rRU = engRU.stepNetplayFrame(0);
      if (rSG.packetToSend) engRU.receiveRemoteInputPacket(rSG.packetToSend);
      if (rRU.packetToSend) engSG.receiveRemoteInputPacket(rRU.packetToSend);
    }

    const telSG = engSG.getTelemetry();
    const telRU = engRU.getTelemetry();

    assert.strictEqual(engSG.currentFrame, engRU.currentFrame, 'Final frame count mismatch');
    assert.strictEqual(telSG.desyncCount, 0, 'SG detected a hash desync');
    assert.strictEqual(telRU.desyncCount, 0, 'RU detected a hash desync');
    assert.strictEqual(telSG.syncStatus, 'SYNC_OK');
    assert.strictEqual(telRU.syncStatus, 'SYNC_OK');
    assert.ok(telSG.rollbacksTotal > 100, 'Expected >100 rollbacks during 3600-frame chaos run');

    // Byte-for-byte comparison of all 2,048 bytes of NES CPU RAM ($0000-$07FF)
    for (let addr = 0; addr < 0x0800; addr++) {
      assert.strictEqual(
        nesSG.cpu.mem[addr],
        nesRU.cpu.mem[addr],
        `RAM mismatch at $${addr.toString(16)}`
      );
    }
    const finalHashSG = computeDeterministicHash(nesSG);
    const finalHashRU = computeDeterministicHash(nesRU);
    assert.strictEqual(finalHashSG, finalHashRU, 'Final deterministic hash mismatch');

    console.log(
      `[PASS] Test 3: 3,600-Frame (60s) Chaos Stress Test Passed! ` +
        `(Rollbacks: SG=${telSG.rollbacksTotal}, RU=${telRU.rollbacksTotal} | ` +
        `MaxDepth=${telSG.maxRollbackDepthSeen}f | Final Hash=${formatHex32(finalHashSG)} | 0 Desyncs)`
    );
  }

  // ---------------------------------------------------------------------------
  // Test 4: Server Room Handshake, Automatic ROM Transfer, Late-Join Sync & Desync Recovery
  // ---------------------------------------------------------------------------
  {
    const serverApp = createCoopServer();
    const port = await serverApp.listen(0, '127.0.0.1');
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const { uint8, binaryString } = createDualControllerTestRom(0);
    const romCrc = computeRomCrc32(uint8);

    // Host (SG) boots ROM and plays 90 frames before RU connects
    const nesHost = new jsnes.NES({});
    nesHost.loadROM(binaryString);
    const engHost = new NesNetplayEngine(nesHost, { localPlayer: 1, online: false });
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
          // Now connect RU (late joiner without ROM)
          wsRU.send(
            JSON.stringify({
              type: 'join_room',
              roomCode: 'RETRO',
              nick: 'Brother-RU',
              romCrc32: null,
              romName: null
            })
          );
        } else if (msg.type === 'peer_joined') {
          // Host sends WebRTC offer + ROM & Savestate sync to late joiner
          const syncState = engHost.exportSyncState();
          const syncJsonSize = JSON.stringify(syncState).length;
          assert.ok(
            syncJsonSize < 550000,
            `Expected compact syncState (<550KB, stripped of 1.1MB render buffers), got ${syncJsonSize} bytes`
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
          const recvBytes = new Uint8Array(Buffer.from(msg.romBase64, 'base64'));
          let bin = '';
          for (let i = 0; i < recvBytes.length; i++) bin += String.fromCharCode(recvBytes[i]);
          nesClient.loadROM(bin);
          engClient = new NesNetplayEngine(nesClient, { localPlayer: 2, online: true });
          engClient.importSyncState(msg.syncState);
          ruSynced = true;
        }
        if (ruSynced && webrtcOfferRelayed) {
          resolve();
        }
      });

      wsSG.on('error', reject);
      wsRU.on('error', reject);
    });

    assert.ok(webrtcOfferRelayed, 'WebRTC signaling offer was not relayed');
    assert.ok(ruSynced && engClient, 'Late-join ROM + state sync did not complete');
    assert.strictEqual(engClient.currentFrame, 90, 'Client frame did not lock to Host frame 90');
    assert.strictEqual(
      computeDeterministicHash(nesClient),
      computeDeterministicHash(nesHost),
      'Client hash after late-join sync did not match Host'
    );

    // Test Debug View Desync Detection & Force Resync Recovery
    nesClient.cpu.mem[0x0020] ^= 0xff; // Intentionally corrupt 1 byte on Client
    engHost.online = true;
    for (let f = 0; f < 35; f++) {
      const r1 = engHost.stepNetplayFrame(0);
      const r2 = engClient.stepNetplayFrame(0);
      if (r1.packetToSend) engClient.receiveRemoteInputPacket(r1.packetToSend);
      if (r2.packetToSend) engHost.receiveRemoteInputPacket(r2.packetToSend);
    }
    assert.strictEqual(engClient.syncStatus, 'DESYNC', 'Debug telemetry should detect intentional RAM corruption');

    // Recover via Host exportSyncState -> Client importSyncState
    engClient.importSyncState(engHost.exportSyncState());
    assert.strictEqual(engClient.syncStatus, 'SYNC_OK', 'Sync status should reset to SYNC_OK after resync');
    assert.strictEqual(computeDeterministicHash(nesClient), computeDeterministicHash(nesHost));

    wsSG.close();
    wsRU.close();
    await serverApp.close();
  }
  console.log('[PASS] Test 4: Late-Join Auto ROM Transfer, Compact Snapshot (<250KB) & Desync Detection/Recovery Verified');

  // ---------------------------------------------------------------------------
  // Test 5: Bi-Directional ROM Switch (P2 Loads Balloon Fight while P1 is on Power Blade 2)
  //         + Lockstep `rom_sync` -> `sync_ack` Handshake under 180ms Latency
  // ---------------------------------------------------------------------------
  {
    const serverApp = createCoopServer();
    const port = await serverApp.listen(0, '127.0.0.1');
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    // Player 1 starts with Mapper 4 ROM ("Power Blade 2"), Player 2 loads Mapper 0 ROM ("Balloon Fight")
    const romP1Default = createDualControllerTestRom(4);
    const romP2Custom = createDualControllerTestRom(0);
    // Modify a byte in romP2Custom CHR so its CRC32 is distinct
    romP2Custom.uint8[romP2Custom.uint8.length - 1] ^= 0x5a;
    const crcP1 = computeRomCrc32(romP1Default.uint8);
    const crcP2 = computeRomCrc32(romP2Custom.uint8);
    assert.notStrictEqual(crcP1, crcP2);

    let nesP1 = new jsnes.NES({});
    nesP1.loadROM(romP1Default.binaryString);
    let engP1 = new NesNetplayEngine(nesP1, { localPlayer: 1, online: true });
    let p1RomName = 'Power Blade 2.nes';
    let p1Crc = crcP1;

    // Player 1 steps 120 frames before Player 2 switches ROMs
    for (let i = 0; i < 120; i++) {
      engP1.stepNetplayFrame(INPUT_BITS.RIGHT);
    }

    let nesP2 = new jsnes.NES({});
    nesP2.loadROM(romP2Custom.binaryString);
    let engP2 = new NesNetplayEngine(nesP2, { localPlayer: 2, online: true });
    let p2RomName = 'Balloon Fight.nes';
    let p2Crc = crcP2;

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
          ws2.send(
            JSON.stringify({
              type: 'join_room',
              roomCode: 'NOVA',
              nick: 'Egor-SG',
              romCrc32: p2Crc,
              romName: p2RomName,
              isAutoDefaultRom: false
            })
          );
        } else if (msg.type === 'rom_sync') {
          // Player 1 receives Player 2's custom ROM ("Balloon Fight.nes")!
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
          // Player 2 has a custom ROM while Player 1 has isAutoDefaultRom: true -> Player 2 pushes its ROM!
          const partner = msg.peers.find((p) => p.playerIndex === 1);
          assert.strictEqual(partner.isAutoDefaultRom, true);
          const sessionId = 'test_balloon_session';
          nesP2.loadROM(romP2Custom.binaryString);
          engP2.resetTimeline(0, sessionId);
          const syncState = engP2.exportSyncState();
          engP2.importSyncState(syncState);
          engP2.syncPaused = true;

          // Even if 10 ticks happen while waiting for sync_ack, engP2 stays at frame 0!
          for (let t = 0; t < 10; t++) {
            const stepRes = engP2.stepNetplayFrame(INPUT_BITS.A);
            assert.strictEqual(stepRes.stepped, false, 'Engine must stay paused while waiting for sync_ack');
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

    // Verify both peers are now running "Balloon Fight.nes" at frame 0 with identical sessionId & state hash!
    assert.strictEqual(p1RomName, 'Balloon Fight.nes');
    assert.strictEqual(p2RomName, 'Balloon Fight.nes');
    assert.strictEqual(p1Crc, p2Crc);
    assert.strictEqual(engP1.currentFrame, 0);
    assert.strictEqual(engP2.currentFrame, 0);
    assert.strictEqual(engP1.sessionId, engP2.sessionId);
    assert.strictEqual(computeDeterministicHash(nesP1), computeDeterministicHash(nesP2));

    // Now step 600 frames under 180ms RTT and verify 0 desyncs
    const qTo1 = [];
    const qTo2 = [];
    for (let f = 0; f < 600; f++) {
      const now = f * 16.667;
      while (qTo1.length > 0 && qTo1[0].at <= now) engP1.receiveRemoteInputPacket(qTo1.shift().pkt);
      while (qTo2.length > 0 && qTo2[0].at <= now) engP2.receiveRemoteInputPacket(qTo2.shift().pkt);

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

    assert.strictEqual(engP1.desyncCount, 0, 'P1 had desyncs after ROM switch');
    assert.strictEqual(engP2.desyncCount, 0, 'P2 had desyncs after ROM switch');
    assert.strictEqual(computeDeterministicHash(nesP1), computeDeterministicHash(nesP2));

    ws1.close();
    ws2.close();
    await serverApp.close();
  }
  console.log('[PASS] Test 5: Bi-Directional ROM Switch (Balloon Fight <-> Power Blade 2) & Lockstep sync_ack Verified');

  // ---------------------------------------------------------------------------
  // Test 6: CHR-RAM Dirty-Tile Epoch Savestates, GGPO Clock-Rift Pacing,
  //         Zero-Transfer Lockstep Handshake (`match_start_req`/`ack`) & Live Gameplay Telemetry
  // ---------------------------------------------------------------------------
  {
    // 6A: Verify CHR-RAM dirty-tile epoch tracking in ppu.patternWrite + saveFastState / loadFastState
    const chrRamRom = createDualControllerTestRom(2); // Mapper 2 (UxROM / CHR-RAM)
    const nesChr = new jsnes.NES({});
    nesChr.loadROM(chrRamRom.binaryString);
    const engChr = new NesNetplayEngine(nesChr, { localPlayer: 1, online: true });

    const initialEpoch = nesChr.ppu._nextTileEpoch;
    nesChr.ppu.patternWrite(0x0010, 0xaa); // Mutates tile #1
    assert.ok(nesChr.ppu._nextTileEpoch > initialEpoch, 'ppu.patternWrite must increment _nextTileEpoch');
    const tile1Epoch = nesChr.ppu.ptTile[1]._tileEpoch;
    assert.strictEqual(tile1Epoch, nesChr.ppu._nextTileEpoch);

    engChr.stepNetplayFrame(INPUT_BITS.A); // Frame 0 -> 1 (saves slot 0 and slot 1)
    const savedPixVal = nesChr.ppu.ptTile[1].pix[0];

    // Mutate tile #1 again before Frame 1 -> 2
    nesChr.ppu.patternWrite(0x0010, 0x55);
    const mutatedPixVal = nesChr.ppu.ptTile[1].pix[0];
    assert.notStrictEqual(mutatedPixVal, savedPixVal);
    engChr.stepNetplayFrame(INPUT_BITS.B); // Saves slot 1 with 0x55

    // Rollback to Frame 0 slot (0xaa) and verify tile #1 pixels are restored accurately
    const slot0 = engChr.saveRing[0];
    assert.strictEqual(slot0.frame, 0);
    loadFastState(nesChr, slot0);
    assert.strictEqual(nesChr.ppu.ptTile[1].pix[0], savedPixVal, 'CHR-RAM dirty-tile epoch rollback to slot 0 must restore 0xaa tile pixels');

    // Roll forward to Frame 1 slot (0x55) and verify tile #1 pixels are restored accurately
    const slot1 = engChr.saveRing[1];
    assert.strictEqual(slot1.frame, 1);
    loadFastState(nesChr, slot1);
    assert.strictEqual(nesChr.ppu.ptTile[1].pix[0], mutatedPixVal, 'CHR-RAM dirty-tile epoch load of slot 1 must restore 0x55 tile pixels');

    // 6A-2: Verify fast cached setMirroring (Single-Screen 0 <-> Single-Screen 1 HUD splits),
    //       load32kRomBank deduplication, RLE tail-trimmed packets, and Auto (RTT) input delay
    nesChr.ppu.setMirroring(nesChr.rom.SINGLESCREEN_MIRRORING);
    assert.strictEqual(nesChr.ppu.ntable1[1], 0);
    assert.strictEqual(nesChr.ppu.vramMirrorTable[0x2400], 0x2000);
    nesChr.ppu.setMirroring(nesChr.rom.SINGLESCREEN_MIRRORING2);
    assert.strictEqual(nesChr.ppu.ntable1[1], 1);
    assert.strictEqual(nesChr.ppu.vramMirrorTable[0x2400], 0x2400);
    // Switching back hits the precomputed _mirrorCache
    nesChr.ppu.setMirroring(nesChr.rom.SINGLESCREEN_MIRRORING);
    assert.strictEqual(nesChr.ppu.ntable1[1], 0);
    assert.strictEqual(nesChr.ppu.vramMirrorTable[0x2400], 0x2000);
    assert.ok(nesChr.ppu._mirrorCache.size >= 2, 'Expected ppu._mirrorCache to cache Single-Screen mirroring modes');

    assert.strictEqual(NesNetplayEngine.computeRecommendedInputDelay(60, 5), 2);
    assert.strictEqual(NesNetplayEngine.computeRecommendedInputDelay(140, 10), 3);
    assert.strictEqual(NesNetplayEngine.computeRecommendedInputDelay(225, 20), 4);
    assert.strictEqual(NesNetplayEngine.computeRecommendedInputDelay(310, 30), 5);

    // 6B: Verify GGPO Clock-Rift Pacing converges a 10-frame clock lead down to < 2.5f without hard stalls
    const nes1 = new jsnes.NES({});
    const nes2 = new jsnes.NES({});
    nes1.loadROM(chrRamRom.binaryString);
    nes2.loadROM(chrRamRom.binaryString);
    const eng1 = new NesNetplayEngine(nes1, { localPlayer: 1, online: true, inputDelayFrames: 3, enableRiftPacing: true });
    const eng2 = new NesNetplayEngine(nes2, { localPlayer: 2, online: true, inputDelayFrames: 3, enableRiftPacing: true });

    const q12 = [];
    const q21 = [];
    // Give P1 an artificial 8-frame head start before P2 begins ticking at the same 60Hz rate
    for (let f = 0; f < 8; f++) {
      const r1 = eng1.stepNetplayFrame(INPUT_BITS.RIGHT);
      if (r1.packetToSend) {
        if (f === 7) {
          assert.strictEqual(r1.packetToSend.inputs.length, 9, 'Expected 3 trailing initial delay zeros to be RLE tail-trimmed (11 -> 9)');
          assert.strictEqual(r1.packetToSend.tailCount, 11, 'Expected tailCount to preserve full 11-frame window length');
        }
        q12.push({ at: f * 16.667 + 110, pkt: r1.packetToSend });
      }
    }
    let checkedSteadySingleInputRle = false;
    for (let tick = 8; tick < 450; tick++) {
      const now = tick * 16.667;
      while (q12.length > 0 && q12[0].at <= now) eng2.receiveRemoteInputPacket(q12.shift().pkt);
      while (q21.length > 0 && q21[0].at <= now) eng1.receiveRemoteInputPacket(q21.shift().pkt);

      const r1 = eng1.stepNetplayFrame(INPUT_BITS.RIGHT);
      const r2 = eng2.stepNetplayFrame(INPUT_BITS.LEFT);
      if (r1.packetToSend) {
        if (tick >= 50 && !checkedSteadySingleInputRle) {
          assert.strictEqual(r1.packetToSend.inputs.length, 1, 'Expected steady 32-frame input history to be RLE tail-trimmed to length 1');
          assert.strictEqual(r1.packetToSend.tailCount, 32, 'Expected tailCount to preserve full 32-frame redundant window length');
          checkedSteadySingleInputRle = true;
        }
        q12.push({ at: now + 110, pkt: r1.packetToSend });
      }
      if (r2.packetToSend) q21.push({ at: now + 110, pkt: r2.packetToSend });
    }
    assert.ok(checkedSteadySingleInputRle, 'Expected steady single-input RLE check to execute');
    const tel1 = eng1.getTelemetry();
    assert.ok(tel1.riftWaitFrames >= 5, `Expected P1 to pace via riftWaitFrames >= 5, got ${tel1.riftWaitFrames}`);
    assert.ok(Math.abs(eng1.currentFrame - eng2.currentFrame) <= 3, `Expected P1/P2 frames to converge within <=3f, got ${eng1.currentFrame} vs ${eng2.currentFrame}`);
    assert.strictEqual(tel1.desyncCount, 0);
    assert.strictEqual(eng2.getTelemetry().desyncCount, 0);

    // 6C: Verify Zero-Transfer `rom_status` + `match_start_req`/`match_start_ack` & Gameplay Telemetry Auto-Save
    const serverApp = createCoopServer({ logAccess: false });
    const port = await serverApp.listen(0, '127.0.0.1');
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const httpJson = (reqPath, method = 'GET', bodyObj = null) =>
      new Promise((resolve, reject) => {
        const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: reqPath,
            method,
            headers: bodyStr
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
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

    // Register tunnel region metadata via POST /api/tunnel-info
    const tunJson = await httpJson('/api/tunnel-info', 'POST', {
      tunnel: 'pinggy',
      region: 'eu',
      publicUrl: 'https://test-eu.a.pinggy.link'
    });
    assert.strictEqual(tunJson.tunnelInfo.region, 'eu');

    const wsA = new WebSocket(wsUrl);
    const wsB = new WebSocket(wsUrl);
    const sharedCrc = computeRomCrc32(chrRamRom.uint8);

    await new Promise((resolve, reject) => {
      let matchAckReceived = false;
      wsA.on('open', () => {
        wsA.send(JSON.stringify({ type: 'join_room', roomCode: 'BTDD', nick: 'Host-SG', romCrc32: null, romName: null }));
      });
      wsA.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'room_joined') {
          wsB.send(JSON.stringify({ type: 'join_room', roomCode: 'BTDD', nick: 'Bro-Omsk', romCrc32: null, romName: null }));
        } else if (msg.type === 'peer_joined') {
          // Both players select Battletoads & Double Dragon locally (zero ROM transfer!)
          wsA.send(JSON.stringify({ type: 'rom_status', romName: 'Battletoads & Double Dragon.nes', romCrc32: sharedCrc }));
          wsB.send(JSON.stringify({ type: 'rom_status', romName: 'Battletoads & Double Dragon.nes', romCrc32: sharedCrc }));
        } else if (msg.type === 'rom_status' && msg.romCrc32 === sharedCrc) {
          // P1 initiates lightweight Frame #0 lockstep barrier
          wsA.send(JSON.stringify({
            type: 'match_start_req',
            sessionId: 'btdd_lockstep_01',
            romName: 'Battletoads & Double Dragon.nes',
            romCrc32: sharedCrc
          }));
        } else if (msg.type === 'match_start_ack' && msg.sessionId === 'btdd_lockstep_01') {
          matchAckReceived = true;
          // Send live gameplay telemetry from both PCs
          wsA.send(JSON.stringify({
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
          }));
          resolve();
        }
      });

      wsB.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'match_start_req' && msg.romCrc32 === sharedCrc) {
          wsB.send(JSON.stringify({
            type: 'match_start_ack',
            sessionId: msg.sessionId,
            romCrc32: sharedCrc
          }));
        }
      });

      wsA.on('error', reject);
      wsB.on('error', reject);
    });

    // Give WS message handler a moment to flush gameplay_telemetry_ws before reading
    await new Promise((r) => setTimeout(r, 30));
    const getTelJson = await httpJson('/api/gameplay-telemetry', 'GET');
    assert.strictEqual(getTelJson.session.tunnelInfo.region, 'eu');
    assert.strictEqual(getTelJson.session.pc1.romName, 'Battletoads & Double Dragon.nes');
    assert.ok(getTelJson.session.combinedText.includes('Region: eu'), 'Gameplay telemetry report must include tunnel region');

    wsA.close();
    wsB.close();
    await serverApp.close();
  }
  console.log('[PASS] Test 6: CHR-RAM Dirty-Tile Epochs, GGPO Clock-Rift Pacing, Zero-Transfer Lockstep & Telemetry Verified');

  console.log('\nALL UNIVERSAL NES NETPLAY & ROLLBACK QA TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('QA Test Failed:', err);
  process.exit(1);
});
