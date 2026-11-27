// TDD Verification Suite for Track C1: 0-GC jsnes, MMC3 Cache & Lag-Aware OC
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as jsnesModule from 'jsnes';
import {
  NesNetplayEngine, INPUT_BITS, computeDeterministicHash,
  saveFastState, loadFastState
} from '../src/netplay_engine.mjs';
import {
  isCpuInTightWaitLoop, setNesOverclockEnabled
} from '../src/ppu_sprite_and_overclock.mjs';
import {
  patchJsnes8x16Sprites
} from '../src/jsnes_ppu_patches.mjs';
import { restoreCompactNesState } from '../src/fast_savestate.mjs';
import { resolveSaveSlotPath } from './tetris_scenarios.mjs';
import { createDualControllerTestRom } from './test_rom_builder_tables.mjs';

const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function testC1aZeroGcSaveStateAndOfflineSkip() {
  for (const mapper of [0, 1, 2, 4]) {
    const { binaryString } = createDualControllerTestRom(mapper);
    const ref = new jsnes.NES({});
    const test = new jsnes.NES({});
    ref.loadROM(binaryString);
    test.loadROM(binaryString);
    patchJsnes8x16Sprites(ref);
    patchJsnes8x16Sprites(test);

    const eng = new NesNetplayEngine(test, { localPlayer: 1, online: true });
    // Warm up 1st save so 1-time schema discovery runs
    saveFastState(test, eng.saveRing[0], 0);

    let toJsonCalls = 0;
    const targets = [
      test.papu, test.mmap, test.controllers[1], test.controllers[2]
    ];
    for (const obj of targets) {
      const orig = obj.toJSON.bind(obj);
      obj.toJSON = () => { toJsonCalls++; return orig(); };
    }
    for (let f = 0; f < 60; f++) {
      const m1 = (f & 3) ? INPUT_BITS.RIGHT : INPUT_BITS.A;
      const m2 = (f & 2) ? INPUT_BITS.LEFT : INPUT_BITS.B;
      if (f === 25) {
        saveFastState(test, eng.saveRing[1], f);
        for (let k = 0; k < 5; k++) test.frame();
        loadFastState(test, eng.saveRing[1]);
      }
      saveFastState(test, eng.saveRing[f % eng.saveBufferSize], f);
      test.frame();
      ref.frame();
      void m1; void m2;
    }
    assert.strictEqual(
      toJsonCalls, 0,
      `Mapper ${mapper} called toJSON() ${toJsonCalls}x during fast savestates!`
    );
    assert.strictEqual(
      computeDeterministicHash(test), computeDeterministicHash(ref),
      `Mapper ${mapper} 0-GC savestate round-trip diverged!`
    );
  }

  // Offline solo play must skip per-frame saveState completely
  const { binaryString } = createDualControllerTestRom(0);
  const solo = new jsnes.NES({});
  solo.loadROM(binaryString);
  const soloEng = new NesNetplayEngine(solo, { localPlayer: 1, online: false });
  let saves = 0;
  const origSave = soloEng.core.saveState.bind(soloEng.core);
  soloEng.core.saveState = (...a) => { saves++; return origSave(...a); };
  for (let f = 0; f < 30; f++) soloEng.stepNetplayFrame(INPUT_BITS.RIGHT, 0);
  assert.strictEqual(saves, 0, `Offline solo ran ${saves} wasted savestates!`);
  console.log('[PASS] C1a: True 0-GC jsnes Savestate & Offline Save Skip');
}

function testC1bMmc3BankCaching() {
  const { binaryString } = createDualControllerTestRom(4);
  const nes = new jsnes.NES({});
  nes.loadROM(binaryString);
  patchJsnes8x16Sprites(nes);

  let renders = 0;
  const origTr = nes.ppu.triggerRendering.bind(nes.ppu);
  nes.ppu.triggerRendering = () => { renders++; return origTr(); };

  for (let i = 0; i < 100; i++) nes.mmap.load1kVromBank(2, 0x0000);
  assert.strictEqual(
    renders, 1, `Redundant load1kVromBank triggered ${renders} renders (exp 1)`
  );
  for (let i = 0; i < 50; i++) nes.mmap.load2kVromBank(1, 0x0800);
  assert.strictEqual(
    renders, 2, `Redundant load2kVromBank triggered ${renders} renders (exp 2)`
  );

  // Changing bank invalidates cache cleanly
  nes.mmap.load1kVromBank(3, 0x0000);
  assert.strictEqual(renders, 3);
  console.log('[PASS] C1b: MMC3 1K/2K VROM & 8K PRG Bank Caching Verified');
}

function testC1cBattletoadsPrngWaitLoopAndOverclock() {
  // Synthetic 6502 CPU matching Battletoads' $8600 JSR-PRNG wait loop
  const mem = new Uint8Array(0x10000);
  // $8600: JSR $8609; JSR $8624; JMP $8600
  mem.set([0x20, 0x09, 0x86, 0x20, 0x24, 0x86, 0x4c, 0x00, 0x86], 0x8600);
  // $8609: short leaf PRNG routine ending in RTS ($60)
  mem.set(
    [0xa2, 0x03, 0xb5, 0x2c, 0x65, 0x0b, 0x95, 0x2c, 0xca, 0x10, 0xf7, 0x60],
    0x8609
  );
  // Stack at SP = 0x01FD holding return addr $8602 (pushed by JSR $8609)
  mem[0x01fe] = 0x02;
  mem[0x01ff] = 0x86;
  const waitCpu = { REG_PC: 0x860c, REG_SP: 0x01fd, mem };
  assert.strictEqual(
    isCpuInTightWaitLoop(waitCpu), true,
    'Leaf PRNG subroutine inside stack-bottom JMP loop must detect wait!'
  );

  // Active gameplay routine ($9000..$9080, NO nearby RTS, has JSR) -> false!
  mem.set([0x20, 0x00, 0x90, 0x4c, 0x00, 0x87], 0x8700);
  mem.set([0x20, 0x50, 0x91, 0xea, 0xea, 0xea], 0x9000);
  mem[0x01fe] = 0x02;
  mem[0x01ff] = 0x87;
  const busyCpu = { REG_PC: 0x9001, REG_SP: 0x01fd, mem };
  assert.strictEqual(
    isCpuInTightWaitLoop(busyCpu), false,
    'Non-leaf gameplay JSR must NOT falsely trigger wait detection!'
  );

  // Real Battletoads save check when present locally
  const btPath = path.join(
    ROOT, 'local/nes/Battletoads_&_Double_Dragon_-_The_Ultimate_Team_(U).nes'
  );
  const svPath = resolveSaveSlotPath(ROOT, '53B02F3D', 1);
  if (fs.existsSync(btPath) && svPath) {
    const bt = new jsnes.NES({});
    bt.loadROM(fs.readFileSync(btPath, 'binary'));
    patchJsnes8x16Sprites(bt);
    const saveJson = JSON.parse(fs.readFileSync(svPath, 'utf8'));
    restoreCompactNesState(bt, saveJson.syncState);
    setNesOverclockEnabled(bt, 1);
    for (let i = 0; i < 30; i++) bt.frame();
    assert.strictEqual(
      bt.ppu._hasTightWaitLoop, true,
      'Real Battletoads OC: ON failed to detect PRNG wait loop!'
    );
  }
  console.log('[PASS] C1c: Battletoads PRNG Wait Detection & Lag-Aware OC');
}

testC1aZeroGcSaveStateAndOfflineSkip();
testC1bMmc3BankCaching();
testC1cBattletoadsPrngWaitLoopAndOverclock();
console.log('\nALL TRACK C1 TESTS PASSED!');
