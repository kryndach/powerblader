// Universal NES, SNES & Sega Netplay & Rollback QA Test Suite Entry Point
import assert from 'assert';
import fs from 'fs';
import * as jsnesModule from 'jsnes';
import {
  NesNetplayEngine, INPUT_BITS,
  computeDeterministicHash, formatHex32,
  saveFastState, loadFastState
} from '../src/netplay_engine.mjs';
import { createDualControllerTestRom } from './test_rom_builder_tables.mjs';
import {
  runTest4LateJoinAndDesync, runTest5BiDirectionalRomSwitch
} from './coop_qa_server_tests.mjs';
import { runTest6ChrRamRiftAndTelemetry } from './coop_qa_advanced_tests.mjs';

const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;

async function runTests() {
  console.log('=== Universal NES Netplay & Rollback QA Test Suite ===\n');

  // Test 1: Multi-Mapper Fast Binary Savestate Determinism (Mappers 0, 1, 2, 4)
  for (const mapperId of [0, 1, 2, 4]) {
    const { binaryString } = createDualControllerTestRom(mapperId);
    const nes = new jsnes.NES({});
    nes.loadROM(binaryString);
    const eng = new NesNetplayEngine(nes, { localPlayer: 1, online: false });

    for (let f = 0; f < 45; f++) {
      eng.stepNetplayFrame((f * 13) & 0xff, (f * 29) & 0xff);
    }

    const savedSlot = eng.saveRing[44 % eng.saveBufferSize];
    saveFastState(nes, savedSlot, 45);
    const hashAt45 = computeDeterministicHash(nes);

    for (let f = 45; f < 75; f++) {
      eng.stepNetplayFrame((f * 7) & 0xff, (f * 19) & 0xff);
    }
    const hashAt75Run1 = computeDeterministicHash(nes);

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
  console.log(
    '[PASS] Test 1: Fast Binary Savestates & Re-simulation Verified ' +
      '(Mappers 0, 1, 2 CHR-RAM, 4 MMC3)'
  );

  // Test 2: Dual Controller ($4016 P1 + $4017 P2) Strobe & Rollback Sync
  {
    const { binaryString } = createDualControllerTestRom(0);
    const nesP1 = new jsnes.NES({});
    const nesP2 = new jsnes.NES({});
    nesP1.loadROM(binaryString);
    nesP2.loadROM(binaryString);
    const engP1 = new NesNetplayEngine(nesP1, {
      localPlayer: 1, online: true, inputDelayFrames: 2
    });
    const engP2 = new NesNetplayEngine(nesP2, {
      localPlayer: 2, online: true, inputDelayFrames: 2
    });
    const p1Combo = INPUT_BITS.RIGHT | INPUT_BITS.A | INPUT_BITS.START;
    const p2Combo = INPUT_BITS.LEFT | INPUT_BITS.B | INPUT_BITS.SELECT;
    for (let i = 0; i < 40; i++) {
      const r1 = engP1.stepNetplayFrame(p1Combo);
      const r2 = engP2.stepNetplayFrame(p2Combo);
      if (r1.packetToSend) engP2.receiveRemoteInputPacket(r1.packetToSend);
      if (r2.packetToSend) engP1.receiveRemoteInputPacket(r2.packetToSend);
    }
    assert.strictEqual(nesP1.cpu.mem[0x0010], nesP2.cpu.mem[0x0010]);
    assert.strictEqual(nesP1.cpu.mem[0x0011], nesP2.cpu.mem[0x0011]);
    assert.strictEqual(nesP1.cpu.mem[0x0020], nesP2.cpu.mem[0x0020]);
    assert.strictEqual(nesP1.cpu.mem[0x0022], nesP2.cpu.mem[0x0022]);
    assert.strictEqual(
      computeDeterministicHash(nesP1), computeDeterministicHash(nesP2)
    );
  }
  console.log(
    '[PASS] Test 2: Controller 1 ($4016) & Controller 2 ($4017) ' +
      'Simultaneous Input Sync Verified'
  );

  // Test 3: 900-Frame (15s) Rollback Stress Test under SG<->RU Network Chaos
  {
    const localRomPath = 'local/nes/Power Blade 2 (U) [!].nes';
    const romData = fs.existsSync(localRomPath)
      ? fs.readFileSync(localRomPath, { encoding: 'binary' })
      : createDualControllerTestRom(4).binaryString;
    const nesSG = new jsnes.NES({});
    const nesRU = new jsnes.NES({});
    nesSG.loadROM(romData);
    nesRU.loadROM(romData);
    const engSG = new NesNetplayEngine(nesSG, {
      localPlayer: 1, online: true, inputDelayFrames: 2,
      maxRollbackFrames: 24, enableRiftPacing: false
    });
    const engRU = new NesNetplayEngine(nesRU, {
      localPlayer: 2, online: true, inputDelayFrames: 2,
      maxRollbackFrames: 24, enableRiftPacing: false
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

    for (let step = 0; step < 900; step++) {
      const nowMs = step * 16.667;
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

    while (inFlightToRU.length > 0) {
      engRU.receiveRemoteInputPacket(inFlightToRU.shift().pkt);
    }
    while (inFlightToSG.length > 0) {
      engSG.receiveRemoteInputPacket(inFlightToSG.shift().pkt);
    }

    for (let settle = 0; settle < 16; settle++) {
      const rSG = engSG.stepNetplayFrame(0);
      const rRU = engRU.stepNetplayFrame(0);
      if (rSG.packetToSend) engRU.receiveRemoteInputPacket(rSG.packetToSend);
      if (rRU.packetToSend) engSG.receiveRemoteInputPacket(rRU.packetToSend);
    }

    const telSG = engSG.getTelemetry();
    const telRU = engRU.getTelemetry();

    assert.strictEqual(engSG.currentFrame, engRU.currentFrame);
    assert.strictEqual(telSG.desyncCount, 0);
    assert.strictEqual(telRU.desyncCount, 0);
    assert.strictEqual(telSG.syncStatus, 'SYNC_OK');
    assert.strictEqual(telRU.syncStatus, 'SYNC_OK');
    assert.ok(telSG.rollbacksTotal > 40);

    for (let addr = 0; addr < 0x0800; addr++) {
      assert.strictEqual(nesSG.cpu.mem[addr], nesRU.cpu.mem[addr]);
    }
    const finalHashSG = computeDeterministicHash(nesSG);
    const finalHashRU = computeDeterministicHash(nesRU);
    assert.strictEqual(finalHashSG, finalHashRU);

    console.log(
      '[PASS] Test 3: 900-Frame (15s) Chaos Stress Test Passed! ' +
        `(Rollbacks: SG=${telSG.rollbacksTotal}, RU=${telRU.rollbacksTotal} ` +
        `| MaxDepth=${telSG.maxRollbackDepthSeen}f | ` +
        `Final Hash=${formatHex32(finalHashSG)} | 0 Desyncs)`
    );
  }

  await runTest4LateJoinAndDesync();
  await runTest5BiDirectionalRomSwitch();
  await runTest6ChrRamRiftAndTelemetry();

  console.log('\nALL UNIVERSAL NES NETPLAY & ROLLBACK QA TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('QA Test Failed:', err);
  process.exit(1);
});
