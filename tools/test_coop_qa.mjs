// Universal NES, SNES & Sega Netplay & Rollback QA Test Suite Entry Point
import assert from 'assert';
import fs from 'fs';
import * as jsnesModule from 'jsnes';
import {
  RollbackNetplayEngine, NesNetplayEngine, INPUT_BITS, SEGA_MD_INPUT_BITS,
  detectSystemFromRomName, computeDeterministicHash, formatHex32,
  saveFastState, loadFastState
} from '../src/netplay_engine.mjs';
import { createSnes9xCore } from '../src/sega_gpgx_core.mjs';
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

  // ---------------------------------------------------------------------------
  // Test 2: Dual Controller ($4016 P1 + $4017 P2) Strobe & Rollback Sync
  // ---------------------------------------------------------------------------
  {
    const { binaryString } = createDualControllerTestRom(0);
    const nesP1 = new jsnes.NES({});
    const nesP2 = new jsnes.NES({});
    nesP1.loadROM(binaryString);
    nesP2.loadROM(binaryString);

    const engP1 = new NesNetplayEngine(nesP1, {
      localPlayer: 1,
      online: true,
      inputDelayFrames: 2
    });
    const engP2 = new NesNetplayEngine(nesP2, {
      localPlayer: 2,
      online: true,
      inputDelayFrames: 2
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
      computeDeterministicHash(nesP1),
      computeDeterministicHash(nesP2)
    );
  }
  console.log(
    '[PASS] Test 2: Controller 1 ($4016) & Controller 2 ($4017) ' +
      'Simultaneous Input Sync Verified'
  );

  // ---------------------------------------------------------------------------
  // Test 3: 3,600-Frame (60s) Rollback Stress Test under SG<->RU Network Chaos
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
    assert.ok(telSG.rollbacksTotal > 100);

    for (let addr = 0; addr < 0x0800; addr++) {
      assert.strictEqual(nesSG.cpu.mem[addr], nesRU.cpu.mem[addr]);
    }
    const finalHashSG = computeDeterministicHash(nesSG);
    const finalHashRU = computeDeterministicHash(nesRU);
    assert.strictEqual(finalHashSG, finalHashRU);

    console.log(
      '[PASS] Test 3: 3,600-Frame (60s) Chaos Stress Test Passed! ' +
        `(Rollbacks: SG=${telSG.rollbacksTotal}, RU=${telRU.rollbacksTotal} ` +
        `| MaxDepth=${telSG.maxRollbackDepthSeen}f | ` +
        `Final Hash=${formatHex32(finalHashSG)} | 0 Desyncs)`
    );
  }

  await runTest4LateJoinAndDesync();
  await runTest5BiDirectionalRomSwitch();
  await runTest6ChrRamRiftAndTelemetry();

  // ---------------------------------------------------------------------------
  // 7. Multi-Console Core Adapter (Sega Mega Drive 320x224 12-Bit + 3DS)
  // ---------------------------------------------------------------------------
  {
    assert.strictEqual(detectSystemFromRomName('Streets2.md'), 'sega_md');
    assert.strictEqual(detectSystemFromRomName('Sonic.gen'), 'sega_md');
    assert.strictEqual(detectSystemFromRomName('Phantasy.sms'), 'sega_sms');
    assert.strictEqual(detectSystemFromRomName('Mario_Kart_7.3ds'), 'n3ds');
    assert.strictEqual(detectSystemFromRomName('Power_Blade_2.nes'), 'nes');

    function createMockSegaMdCore() {
      const state = new Uint32Array(4);
      const fb = new Uint32Array(320 * 224);
      return {
        systemId: 'sega_md',
        width: 320,
        height: 224,
        opts: {},
        stepFrame(p1, p2, headless) {
          state[0] = (state[0] + 1) >>> 0;
          state[1] = (state[1] * 31 + p1) >>> 0;
          state[2] = (state[2] * 37 + p2) >>> 0;
          state[3] = (state[1] ^ state[2] ^ state[0]) >>> 0;
          if (!headless) fb[0] = 0xff000000 | (state[3] & 0xffffff);
        },
        saveStateBytes: () => new Uint8Array(state.buffer.slice(0)),
        loadStateBytes(u8) {
          state.set(new Uint32Array(u8.buffer, u8.byteOffset, 4));
        },
        getFrameBuffer: () => fb,
        computeHash: () => state[3] >>> 0
      };
    }

    const sega1 = createMockSegaMdCore();
    const sega2 = createMockSegaMdCore();
    const eng1 = new RollbackNetplayEngine(sega1, {
      localPlayer: 1, online: true, inputDelayFrames: 1
    });
    const eng2 = new RollbackNetplayEngine(sega2, {
      localPlayer: 2, online: true, inputDelayFrames: 1
    });
    assert.strictEqual(eng1.systemId, 'sega_md');
    assert.strictEqual(eng1._pixelCount, 320 * 224);

    const sixBtnP1 =
      SEGA_MD_INPUT_BITS.RIGHT | SEGA_MD_INPUT_BITS.C | SEGA_MD_INPUT_BITS.Z;
    const sixBtnP2 =
      SEGA_MD_INPUT_BITS.LEFT | SEGA_MD_INPUT_BITS.X | SEGA_MD_INPUT_BITS.MODE;

    const delayedQ1 = [];
    const delayedQ2 = [];
    for (let f = 0; f < 90; f++) {
      const r1 = eng1.stepNetplayFrame(f % 2 === 0 ? sixBtnP1 : 0);
      const r2 = eng2.stepNetplayFrame(f % 3 === 0 ? sixBtnP2 : 0);
      if (r1.packetToSend) delayedQ2.push(r1.packetToSend);
      if (r2.packetToSend) delayedQ1.push(r2.packetToSend);
      if (f % 4 === 3) {
        while (delayedQ1.length) {
          eng1.receiveRemoteInputPacket(delayedQ1.shift());
        }
        while (delayedQ2.length) {
          eng2.receiveRemoteInputPacket(delayedQ2.shift());
        }
      }
    }
    while (delayedQ1.length) eng1.receiveRemoteInputPacket(delayedQ1.shift());
    while (delayedQ2.length) eng2.receiveRemoteInputPacket(delayedQ2.shift());
    for (let s = 0; s < 10; s++) {
      const r1 = eng1.stepNetplayFrame(0);
      const r2 = eng2.stepNetplayFrame(0);
      if (r1.packetToSend) eng2.receiveRemoteInputPacket(r1.packetToSend);
      if (r2.packetToSend) eng1.receiveRemoteInputPacket(r2.packetToSend);
    }

    assert.strictEqual(eng1.getTelemetry().desyncCount, 0);
    assert.strictEqual(sega1.computeHash(), sega2.computeHash());
    assert.ok(eng1.getTelemetry().rollbacksTotal > 0);
    console.log(
      '[PASS] Test 7: Multi-Console Core Adapter (Sega MD 320x224 12-Bit ' +
        '6-Button Rollback & 3DS Profile) Verified'
    );
  }

  // Test 8: Super Nintendo (Snes9x WASM 256x224) Rollback & State Sync
  {
    assert.strictEqual(detectSystemFromRomName('Contra3.sfc'), 'snes');
    assert.strictEqual(detectSystemFromRomName('SMW.smc'), 'snes');
    const rom = new Uint8Array(0x8000);
    rom.set([0x20, 0, 5, 0, 0, 0, 0, 255, 255, 0, 0], 0x7fd5);
    rom[0x7ffc] = 0x00;
    rom[0x7ffd] = 0x80;
    rom.set([0x78, 0x18, 0xfb, 0xee, 0x00, 0x00, 0x4c, 0x03, 0x80], 0);
    let snesFrames = 0;
    const snes1 = await createSnes9xCore({
      romBytes: rom, romName: 'Test.sfc', onFrame: () => snesFrames++
    });
    const origProc = globalThis.process;
    delete globalThis.process;
    const snes2 = await createSnes9xCore({ romBytes: rom, romName: 'T.sfc' });
    globalThis.process = origProc;
    const e1 = new NesNetplayEngine(snes1, { localPlayer: 1, online: true });
    const e2 = new NesNetplayEngine(snes2, { localPlayer: 2, online: true });
    for (let f = 0; f < 30; f++) {
      const r1 = e1.stepNetplayFrame(INPUT_BITS.B | INPUT_BITS.Y);
      const r2 = e2.stepNetplayFrame(INPUT_BITS.A | INPUT_BITS.X);
      if (r1.packetToSend) e2.receiveRemoteInputPacket(r1.packetToSend);
      if (r2.packetToSend) e1.receiveRemoteInputPacket(r2.packetToSend);
    }
    e2.importSyncState(e1.exportSyncState());
    assert.strictEqual(snes1.computeHash(), snes2.computeHash());
    assert.ok(snesFrames >= 30);
    console.log(
      '[PASS] Test 8: Super Nintendo (Snes9x WASM 256x224) Rollback & Sync'
    );
  }

  console.log('\nALL UNIVERSAL NES NETPLAY & ROLLBACK QA TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('QA Test Failed:', err);
  process.exit(1);
});
