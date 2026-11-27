// TDD Regression Suite: Audit Priority 2b (Mapper 119/5, Cache & OC Cooldown)
import assert from 'assert';
import * as jsnesMod from 'jsnes';
import {
  NesNetplayEngine, saveFastState, loadFastState
} from '../src/netplay_engine.mjs';
import {
  serializeCompactNesState, restoreCompactNesState
} from '../src/fast_savestate.mjs';
import {
  patchJsnes8x16Sprites, setNesOverclockEnabled
} from '../src/jsnes_ppu_patches.mjs';
import { createDualControllerTestRom } from './test_rom_builder_tables.mjs';

const jsnes = jsnesMod.NES ? jsnesMod : jsnesMod.default;

function makeSyntheticMapperRom(mapperNum, vromBanks = 2) {
  const hdr = new Uint8Array(16);
  hdr.set([0x4e, 0x45, 0x53, 0x1a, 2, vromBanks], 0);
  hdr[6] = (mapperNum & 0x0f) << 4;
  hdr[7] = mapperNum & 0xf0;
  const prg = new Uint8Array(32768);
  prg.set([0x4c, 0x00, 0x80], 0);
  prg[0x7ffa] = 0x00; prg[0x7ffb] = 0x80;
  prg[0x7ffc] = 0x00; prg[0x7ffd] = 0x80;
  prg[0x7ffe] = 0x00; prg[0x7fff] = 0x80;
  const chr = new Uint8Array(vromBanks * 8192);
  for (let i = 0; i < chr.length; i++) chr[i] = ((i >> 10) + 1) & 0xff;
  const full = new Uint8Array(16 + prg.length + chr.length);
  full.set(hdr, 0); full.set(prg, 16); full.set(chr, 16 + prg.length);
  let bin = '';
  for (let i = 0; i < full.length; i++) bin += String.fromCharCode(full[i]);
  return bin;
}

function testP2_8Mapper119Mapper5TimelineResetAndCooldown() {
  // 1. Mapper 119: VROM -> CHR-RAM -> same VROM must reload VROM tiles
  const rom119 = makeSyntheticMapperRom(119, 2);
  const nes119 = new jsnes.NES({});
  nes119.loadROM(rom119);
  patchJsnes8x16Sprites(nes119);
  nes119.mmap.executeCommand(2, 1); // $1000 <- VROM 1K bank 1
  const vromByte = nes119.ppu.vramMem[0x1000];
  nes119.mmap.executeCommand(2, 0x40); // $1000 <- CHR-RAM bank 0
  nes119.ppu.vramMem[0x1000] = 0x99;
  nes119.ppu.patternWrite(0x1000, 0x99);
  const eng119 = new NesNetplayEngine(nes119, { localPlayer: 1, online: true });
  const slot119 = eng119.saveRing[0];
  saveFastState(nes119, slot119, 10);
  const compact119 = serializeCompactNesState(nes119, 's119', 10, 0);

  nes119.mmap.executeCommand(2, 1);
  assert.strictEqual(
    nes119.ppu.vramMem[0x1000], vromByte,
    'Mapper 119 VROM->CHR-RAM->VROM returned stale CHR-RAM!'
  );
  nes119.mmap.executeCommand(2, 0x40);
  nes119.ppu.vramMem[0x1000] = 0x00;
  nes119.ppu.patternWrite(0x1000, 0x00);
  loadFastState(nes119, slot119);
  assert.strictEqual(nes119.mmap.chrRamSlots[4], 0);
  assert.strictEqual(nes119.mmap.chrRam[0], 0x99);
  assert.strictEqual(nes119.ppu.ptTile[256].pix[0], 1);
  // Ensure chrRamSlots snapshot is not aliased across rollbacks
  nes119.mmap.chrRamSlots[4] = 7;
  loadFastState(nes119, slot119);
  assert.strictEqual(nes119.mmap.chrRamSlots[4], 0);

  const nes119b = new jsnes.NES({});
  nes119b.loadROM(rom119);
  patchJsnes8x16Sprites(nes119b);
  restoreCompactNesState(nes119b, compact119);
  assert.strictEqual(nes119b.ppu.ptTile[256].pix[0], 1);

  // 2. Mapper 5 (MMC5): rollback preserves exramMode, bgTileOverride & exram
  const rom5 = makeSyntheticMapperRom(5, 2);
  const nes5 = new jsnes.NES({});
  nes5.loadROM(rom5);
  patchJsnes8x16Sprites(nes5);
  nes5.mmap.write(0x5104, 1);
  nes5.mmap.inFrame = true;
  nes5.mmap.write(0x5c00, 0x55);
  const eng5 = new NesNetplayEngine(nes5, { localPlayer: 1, online: true });
  saveFastState(nes5, eng5.saveRing[0], 5);
  nes5.mmap.write(0x5104, 2);
  nes5.mmap.write(0x5c00, 0xaa);
  loadFastState(nes5, eng5.saveRing[0]);
  assert.strictEqual(nes5.mmap.exramMode, 1);
  assert.strictEqual(nes5.mmap.bgTileOverride, true);
  assert.strictEqual(nes5.mmap.exram[0], 0x55);
  assert.strictEqual(nes5.mmap._chrBankTarget, -1);

  // 3. NesCoreAdapter.onTimelineReset() invalidates _prg8k & _vrom1k
  const rom4 = createDualControllerTestRom(4).binaryString;
  const nes4 = new jsnes.NES({});
  nes4.loadROM(rom4);
  const eng4 = new NesNetplayEngine(nes4, { localPlayer: 1, online: true });
  nes4.mmap._prg8k[0] = 3;
  nes4.mmap._vrom1k[0] = 5;
  eng4.resetTimeline(0, 'reset_cache');
  assert.strictEqual(nes4.mmap._prg8k[0], -1);
  assert.strictEqual(nes4.mmap._vrom1k[0], -1);

  // 4. ppu._overclockCooldown saved/restored/reset everywhere
  setNesOverclockEnabled(nes4, 1);
  nes4.ppu._overclockCooldown = 6;
  saveFastState(nes4, eng4.saveRing[1], 1);
  const sync4 = serializeCompactNesState(nes4, 'oc_cd', 1, 0);
  nes4.ppu._overclockCooldown = 0;
  loadFastState(nes4, eng4.saveRing[1]);
  assert.strictEqual(nes4.ppu._overclockCooldown, 6);
  nes4.ppu._overclockCooldown = 0;
  restoreCompactNesState(nes4, sync4);
  assert.strictEqual(nes4.ppu._overclockCooldown, 6);
  setNesOverclockEnabled(nes4, 1);
  assert.strictEqual(nes4.ppu._overclockCooldown, 0);
  nes4.ppu._overclockCooldown = 5;
  nes4.loadROM(rom4);
  assert.strictEqual(nes4.ppu._overclockCooldown, 0);
  console.log('[PASS] P2-8: Mapper 119, Mapper 5, Cache Reset & OC Cooldown');
}

console.log('=== Audit Priority 2b (Emulation) Regression Suite ===\n');
testP2_8Mapper119Mapper5TimelineResetAndCooldown();
console.log('\nALL AUDIT PRIORITY 2B TESTS PASSED!');
