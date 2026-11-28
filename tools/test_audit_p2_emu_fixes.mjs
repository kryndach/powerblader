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
  const prg = new Uint8Array(32768).fill(0xea);
  const base = 0x6000; // $E000-$FFFF (fixed last 8KB on Mapper 4/5/118/119)
  let pc = base;
  const emit = (...b) => { for (const x of b) prg[pc++] = x & 0xff; };
  // $E000 RESET: SEI; CLD; LDX #$FF; TXS; BIT $2002; enable NMI + BG/SPR
  emit(0x78, 0xd8, 0xa2, 0xff, 0x9a, 0x2c, 0x02, 0x20);
  emit(0xa9, 0x80, 0x8d, 0x00, 0x20, 0xa9, 0x1e, 0x8d, 0x01, 0x20);
  while (pc < base + 0x20) emit(0xea);
  emit(0xe6, 0x00, 0x4c, 0x20, 0xe0); // $E020: INC $00; JMP $E020
  // $E040 NMI: read $4016/$4017 -> $10/$11, then exercise mapper registers!
  pc = base + 0x40;
  emit(0x48, 0x8a, 0x48, 0x98, 0x48);
  emit(0xa9, 0x01, 0x8d, 0x16, 0x40, 0xa9, 0x00, 0x8d, 0x16, 0x40);
  emit(0xa2, 0x08);
  const lp = pc;
  emit(0xad, 0x16, 0x40, 0x4a, 0x66, 0x10);
  emit(0xad, 0x17, 0x40, 0x4a, 0x66, 0x11);
  emit(0xca, 0xd0, (lp - (pc + 2)) & 0xff);
  emit(0xa5, 0x20, 0x18, 0x65, 0x10, 0x65, 0x11, 0x85, 0x20, 0xe6, 0x21);
  if (mapperNum === 5) {
    // ExRAM mode 2 -> write $5C00 -> mode 1 + hw mult $5205/$5206 + CHR $5120
    emit(0xa9, 0x02, 0x8d, 0x04, 0x51);
    emit(0xa5, 0x20, 0x8d, 0x00, 0x5c, 0x8d, 0x05, 0x52);
    emit(0xa5, 0x21, 0x8d, 0x06, 0x52);
    emit(0xad, 0x05, 0x52, 0x85, 0x30, 0xad, 0x06, 0x52, 0x85, 0x31);
    emit(0xa5, 0x20, 0x29, 0x01, 0x8d, 0x04, 0x51);
    emit(0xa5, 0x20, 0x29, 0x03, 0x8d, 0x20, 0x51);
  } else if (mapperNum === 119) {
    // Toggle slot 4 ($1000) between VROM and CHR-RAM + write CHR-RAM via $2007
    emit(0xa9, 0x02, 0x8d, 0x00, 0x80);
    emit(0xa5, 0x20, 0x29, 0x03, 0x09, 0x40, 0x8d, 0x01, 0x80);
    emit(0x2c, 0x02, 0x20, 0xa9, 0x10, 0x8d, 0x06, 0x20);
    emit(0xa9, 0x00, 0x8d, 0x06, 0x20, 0xa5, 0x20, 0x8d, 0x07, 0x20);
    emit(0xa5, 0x20, 0x29, 0x01, 0xf0, 0x05);
    emit(0xa9, 0x01, 0x8d, 0x01, 0x80);
  }
  emit(0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40);
  prg.set([0x40, 0xe0, 0x00, 0xe0, 0x40, 0xe0], 0x7ffa);
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

  // 1b. Mapper 119: stale _tileEpoch collision across unmapped bank rollback
  const nes119c = new jsnes.NES({});
  nes119c.loadROM(rom119);
  patchJsnes8x16Sprites(nes119c);
  const eng119c = new NesNetplayEngine(nes119c, {
    localPlayer: 1, online: true
  });
  nes119c.mmap.executeCommand(2, 1); // Frame 0: slot 4 = VROM (bank 1 unmapped)
  saveFastState(nes119c, eng119c.saveRing[0], 0);
  // Mispredicted Frame 1: map CHR-RAM bank 1 & write 0xFF (epoch bumps to 2)
  nes119c.mmap.executeCommand(2, 0x41);
  nes119c.ppu.vramMem[0x1000] = 0xff;
  nes119c.ppu.patternWrite(0x1000, 0xff);
  saveFastState(nes119c, eng119c.saveRing[1], 1);
  // Rollback to Frame 0 -> bank 1 chrRam restored to 0x00
  loadFastState(nes119c, eng119c.saveRing[0]);
  // Corrected Frame 1: map CHR-RAM bank 1 WITHOUT writing 0xFF (still 0x00)
  nes119c.mmap.executeCommand(2, 0x41);
  assert.strictEqual(nes119c.ppu.ptTile[256].pix[0], 0);
  saveFastState(nes119c, eng119c.saveRing[1], 1);
  // Frame 2: write 0x55 (bumps epoch), then rollback to corrected Frame 1
  nes119c.ppu.vramMem[0x1000] = 0x55;
  nes119c.ppu.patternWrite(0x1000, 0x55);
  loadFastState(nes119c, eng119c.saveRing[1]);
  assert.strictEqual(
    nes119c.ppu.ptTile[256].pix[0], 0,
    'Mapper 119 rollback resurrected stale mispredicted CHR-RAM tile!'
  );

  // 2. Mapper 5 (MMC5): rollback & fresh-peer sync restore bgTileOverride
  const rom5 = makeSyntheticMapperRom(5, 2);
  const nes5 = new jsnes.NES({});
  nes5.loadROM(rom5);
  patchJsnes8x16Sprites(nes5);
  nes5.mmap.write(0x5104, 1);
  nes5.mmap.inFrame = true;
  nes5.mmap.write(0x5c00, 0x55);
  const eng5 = new NesNetplayEngine(nes5, { localPlayer: 1, online: true });
  saveFastState(nes5, eng5.saveRing[0], 5);
  const sync5 = serializeCompactNesState(nes5, 'm5_sync', 5, 0);
  nes5.mmap.write(0x5104, 2);
  nes5.mmap.write(0x5c00, 0xaa);
  loadFastState(nes5, eng5.saveRing[0]);
  assert.strictEqual(nes5.mmap.exramMode, 1);
  assert.strictEqual(nes5.mmap.bgTileOverride, true);
  assert.strictEqual(nes5.mmap.exram[0], 0x55);
  assert.strictEqual(nes5.mmap._chrBankTarget, -1);

  // Fresh Mapper 5 peer (never wrote $5104) MUST get bgTileOverride=true & no
  // spurious triggerRendering() during restoreCompactNesState!
  const nes5b = new jsnes.NES({});
  nes5b.loadROM(rom5);
  patchJsnes8x16Sprites(nes5b);
  let trigDuringRestore = 0;
  const origTrig = nes5b.ppu.triggerRendering.bind(nes5b.ppu);
  nes5b.ppu.triggerRendering = function () {
    if (!this._inRendering) trigDuringRestore++;
    return origTrig();
  };
  restoreCompactNesState(nes5b, sync5);
  assert.strictEqual(nes5b.mmap.exramMode, 1);
  assert.strictEqual(
    nes5b.mmap.bgTileOverride, true,
    'Fresh Mapper 5 peer missed bgTileOverride=true after state_sync!'
  );
  assert.strictEqual(nes5b.mmap.exram[0], 0x55);
  assert.strictEqual(
    trigDuringRestore, 0,
    'restoreCompactNesState triggered rendering mid-restore on Mapper 5!'
  );

  // 2b. Mapper 118 (TxSROM): chrRegs must not alias syncObj after restore
  const rom118 = makeSyntheticMapperRom(118, 2);
  const nes118a = new jsnes.NES({}); nes118a.loadROM(rom118);
  patchJsnes8x16Sprites(nes118a);
  nes118a.mmap.executeCommand(0, 0x80);
  const sync118 = serializeCompactNesState(nes118a, 'm118', 2, 0);
  const nes118b = new jsnes.NES({}); nes118b.loadROM(rom118);
  patchJsnes8x16Sprites(nes118b);
  restoreCompactNesState(nes118b, sync118);
  nes118b.mmap.chrRegs[0] = 0x00;
  assert.strictEqual(
    sync118.nesState.mmap.chrRegs[0], 0x80,
    'Mapper 118 restoreCompactNesState aliased syncObj.chrRegs!'
  );

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

  // 5. 120-frame Mapper 5 & Mapper 119 live rollback hash-equality stress
  for (const [label, bin] of [['Mapper5', rom5], ['Mapper119', rom119]]) {
    const n1 = new jsnes.NES({}), n2 = new jsnes.NES({});
    n1.loadROM(bin); n2.loadROM(bin);
    const e1 = new NesNetplayEngine(n1, { localPlayer: 1, online: true });
    const e2 = new NesNetplayEngine(n2, { localPlayer: 2, online: true });
    e1.resetTimeline(0, `rb_${label}`);
    e2.resetTimeline(0, `rb_${label}`);
    const q12 = [], q21 = [];
    for (let f = 0; f < 120; f++) {
      while (q12.length && q12[0].at <= f) {
        e2.receiveRemoteInputPacket(q12.shift().p);
      }
      while (q21.length && q21[0].at <= f) {
        e1.receiveRemoteInputPacket(q21.shift().p);
      }
      const r1 = e1.stepNetplayFrame((f % 7) < 3 ? 1 : 0);
      const r2 = e2.stepNetplayFrame((f % 9) < 4 ? 2 : 0);
      if (r1.packetToSend) q12.push({ at: f + 5, p: r1.packetToSend });
      if (r2.packetToSend) q21.push({ at: f + 5, p: r2.packetToSend });
    }
    while (q12.length) e2.receiveRemoteInputPacket(q12.shift().p);
    while (q21.length) e1.receiveRemoteInputPacket(q21.shift().p);
    for (let i = 0; i < 6; i++) {
      const r1 = e1.stepNetplayFrame(0), r2 = e2.stepNetplayFrame(0);
      if (r1.packetToSend) e2.receiveRemoteInputPacket(r1.packetToSend);
      if (r2.packetToSend) e1.receiveRemoteInputPacket(r2.packetToSend);
    }
    assert.ok(e1.rollbacksTotal > 0 && e2.rollbacksTotal > 0, `${label} 0 RB`);
    assert.strictEqual(e1.desyncCount + e2.desyncCount, 0, `${label} desync!`);
    assert.strictEqual(
      e1.core.computeHash(), e2.core.computeHash(), `${label} final hash diff!`
    );
  }
  console.log('[PASS] P2-8: Mapper 119, Mapper 5, Cache Reset & OC Cooldown');
}

console.log('=== Audit Priority 2b (Emulation) Regression Suite ===\n');
testP2_8Mapper119Mapper5TimelineResetAndCooldown();
console.log('\nALL AUDIT PRIORITY 2B TESTS PASSED!');
