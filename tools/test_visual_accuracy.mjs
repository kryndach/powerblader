// Automated Real-ROM Visual Pixel-Stability & Sprite Accuracy Suite
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as jsnesMod from 'jsnes';
import {
  patchJsnes8x16Sprites, setNesOverclockEnabled
} from '../src/jsnes_ppu_patches.mjs';
import {
  NesNetplayEngine, INPUT_BITS, computeRomCrc32
} from '../src/netplay_engine.mjs';
import { resolveSaveSlotPath } from './tetris_scenarios.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const NES_DIR = path.join(ROOT_DIR, 'local', 'nes');
const jsnes = jsnesMod.NES ? jsnesMod : jsnesMod.default;

function findRom(substr) {
  if (!fs.existsSync(NES_DIR)) return null;
  const f = fs.readdirSync(NES_DIR).find(
    (n) => n.endsWith('.nes') && n.toLowerCase().includes(substr.toLowerCase())
  );
  return f ? fs.readFileSync(path.join(NES_DIR, f), 'binary') : null;
}

function testBattletoadsTitleScanline87Stability() {
  const romBin = findRom('battletoads');
  if (!romBin) return;
  let curFb = null, prevFb = null;
  const nes = new jsnes.NES({ onFrame: (fb) => { curFb = fb.slice(); } });
  nes.loadROM(romBin);
  patchJsnes8x16Sprites(nes);

  const flashes = [];
  for (let f = 0; f < 1100; f++) {
    nes.frame();
    if (f >= 685 && prevFb && curFb) {
      let row87Diff = 0;
      const base = 87 * 256;
      for (let x = 0; x < 256; x++) {
        if ((curFb[base + x] & 0xffffff) !== (prevFb[base + x] & 0xffffff)) {
          row87Diff++;
        }
      }
      if (row87Diff > 20) flashes.push({ f, row87Diff });
    }
    prevFb = curFb;
  }
  assert.strictEqual(
    flashes.length, 0,
    `Battletoads title screen scanline 87 flashed ${flashes.length}x: ` +
      JSON.stringify(flashes.slice(0, 5))
  );
}

function runBattletoadsCharSelect(romBin, overclockOn) {
  let curFb = null, prevFb = null;
  const nes = new jsnes.NES({ onFrame: (fb) => { curFb = fb.slice(); } });
  nes.loadROM(romBin);
  patchJsnes8x16Sprites(nes);
  assert.strictEqual(nes.ppu._overclockEnabled, false);
  if (overclockOn) setNesOverclockEnabled(nes, true);

  const glitches = [];
  for (let f = 0; f < 1400; f++) {
    const startBtn = (f >= 720 && f < 726) || (f >= 780 && f < 786);
    nes.controllers[1].state[3] = startBtn ? 0x41 : 0x40;
    nes.frame();
    if (f >= 825 && prevFb && curFb) {
      let diffPx = 0, minY = 240, maxY = -1;
      for (let y = 0; y < 240; y++) {
        for (let x = 0; x < 256; x++) {
          if (y >= 24 && y <= 31 && x >= 44 && x <= 212) continue;
          if ((curFb[y * 256 + x] & 0xffffff) !==
              (prevFb[y * 256 + x] & 0xffffff)) {
            diffPx++;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (diffPx > 0) glitches.push({ f, diffPx, rows: `${minY}..${maxY}` });
    }
    prevFb = curFb;
  }
  const mode = overclockOn ? 'OC=ON' : 'OC=OFF';
  assert.strictEqual(
    glitches.length, 0,
    `Battletoads char select (${mode}) blinked ${glitches.length}x: ` +
      JSON.stringify(glitches.slice(0, 4))
  );
  assert.strictEqual(nes.ppu._hasTightWaitLoop, false);
}

function testBattletoadsCharacterSelectStability() {
  const romBin = findRom('battletoads');
  if (!romBin) return;
  runBattletoadsCharSelect(romBin, false);
  runBattletoadsCharSelect(romBin, true);

  const archonBin = findRom('archon');
  if (!archonBin) return;
  const n = new jsnes.NES({ onFrame: () => {} });
  n.loadROM(archonBin);
  patchJsnes8x16Sprites(n);
  setNesOverclockEnabled(n, true);
  let ocTotal = 0;
  const origEnd = n.ppu.endScanline.bind(n.ppu);
  n.ppu.endScanline = function () {
    const prev = this._overclockScanlines || 0;
    const res = origEnd();
    if ((this._overclockScanlines || 0) > prev) ocTotal++;
    return res;
  };
  for (let f = 0; f < 650; f++) {
    n.controllers[1].state[3] = f >= 60 && f < 65 ? 0x41 : 0x40;
    n.frame();
  }
  assert.ok(ocTotal <= 240, `Archon runaway overclock: ${ocTotal} scanlines`);
}

function testBattletoadsRollbackCrispPaletteNoFading() {
  const romBin = findRom('battletoads');
  if (!romBin) return;
  let lastFb = null;
  const nes = new jsnes.NES({ onFrame: (fb) => { lastFb = fb.slice(); } });
  nes.loadROM(romBin);
  patchJsnes8x16Sprites(nes);
  const eng = new NesNetplayEngine(nes, {
    localPlayer: 1, online: true, inputDelayFrames: 2, maxRollbackFrames: 40
  });
  eng.resetTimeline(0, 's_crisp');

  for (let f = 0; f < 740; f++) {
    const m1 = f >= 715 && f < 720 ? INPUT_BITS.START : 0;
    eng.stepNetplayFrame(m1);
    eng.receiveRemoteInputPacket({
      type: 'netplay_input', sessionId: 's_crisp', player: 2,
      startFrame: f, inputs: [0]
    });
  }
  // Force a 7-frame rollback where visual alpha-blending would fade pixels
  for (let f = 740; f < 748; f++) eng.stepNetplayFrame(INPUT_BITS.RIGHT);
  eng.receiveRemoteInputPacket({
    type: 'netplay_input', sessionId: 's_crisp', player: 2,
    startFrame: 747,
    inputs: [
      INPUT_BITS.LEFT, INPUT_BITS.LEFT, INPUT_BITS.LEFT, INPUT_BITS.LEFT,
      INPUT_BITS.LEFT, INPUT_BITS.LEFT, INPUT_BITS.LEFT, INPUT_BITS.LEFT
    ]
  });
  eng.stepNetplayFrame(INPUT_BITS.RIGHT);
  assert.ok(eng.rollbacksTotal > 0, 'Expected rollback to trigger');
  assert.strictEqual(
    eng.smoothedFramesCount, 0,
    `Rollback alpha-blending faded sprites (${eng.smoothedFramesCount} frames)`
  );

  // Also verify every pixel on screen belongs to the NES PPU palette (no blend)
  const validCols = new Set();
  for (let i = 0; i < 16; i++) {
    validCols.add(nes.ppu.imgPalette[i] & 0xffffff);
    validCols.add(nes.ppu.sprPalette[i] & 0xffffff);
  }
  let blendedPx = 0;
  for (let i = 0; i < lastFb.length; i++) {
    if (!validCols.has(lastFb[i] & 0xffffff)) blendedPx++;
  }
  assert.strictEqual(
    blendedPx, 0,
    `Found ${blendedPx} non-palette alpha-blended ghost pixels after rollback`
  );
}

function testOverflow12SpritesPerScanlineAllVisible() {
  const romBin = findRom('battletoads');
  if (!romBin) return;
  const nes = new jsnes.NES({ onFrame: () => {} });
  nes.loadROM(romBin);
  patchJsnes8x16Sprites(nes);
  for (let f = 0; f < 700; f++) nes.frame();

  const ppu = nes.ppu;
  ppu.f_spVisibility = 1;
  ppu.f_spriteSize = 0;
  ppu.f_spPatternTable = 0;
  ppu.sprPalette[1] = 0xff00ff;
  // Build solid opaque tile #1
  ppu.ptTile[1].pix.fill(1);
  ppu.ptTile[1].opaque.fill(1);
  ppu.spriteMem.fill(0xf8);
  // Place 12 non-overlapping 8x8 sprites on Y = 100 (display scanline 101)
  for (let n = 0; n < 12; n++) {
    ppu.spriteMem[n * 4 + 0] = 100;
    ppu.spriteMem[n * 4 + 1] = 1;
    ppu.spriteMem[n * 4 + 2] = 0;
    ppu.spriteMem[n * 4 + 3] = 8 + n * 16;
  }
  ppu.buffer.fill(0);
  ppu.pixrendered.fill(65);
  ppu.evaluateSprites(101);
  ppu.renderSpritesPartially(101, 1, 0);

  let visible = 0;
  for (let n = 0; n < 12; n++) {
    const x = 8 + n * 16 + 2;
    if ((ppu.buffer[101 * 256 + x] & 0xffffff) === 0xff00ff) visible++;
  }
  assert.strictEqual(
    visible, 12,
    `Expected all 12 sprites on scanline 101 to render, got ${visible}/12`
  );
}

function testTmnt3RealHudAndBattletoadsStage1Visuals() {
  const tmntBin = findRom('turtles');
  if (tmntBin) {
    const crc = computeRomCrc32(Buffer.from(tmntBin, 'binary'));
    const savePath = resolveSaveSlotPath(ROOT_DIR, crc, 1);
    if (savePath) {
      let fb = null;
      const nes = new jsnes.NES({ onFrame: (b) => { fb = b.slice(); } });
      nes.loadROM(tmntBin);
      patchJsnes8x16Sprites(nes);
      const eng = new NesNetplayEngine(nes, { localPlayer: 1, online: false });
      const saveObj = JSON.parse(fs.readFileSync(savePath, 'utf8'));
      eng.importSyncState(saveObj.syncState);
      let hudBroken = 0;
      for (let f = 0; f < 90; f++) {
        const m1 = (f % 16 < 8 ? INPUT_BITS.RIGHT : INPUT_BITS.LEFT) |
          (f % 12 < 3 ? INPUT_BITS.B : 0);
        eng.stepNetplayFrame(m1, INPUT_BITS.RIGHT);
        let hudNonBlack = 0;
        for (let y = 200; y < 230; y++) {
          for (let x = 20; x < 236; x++) {
            if ((fb[y * 256 + x] & 0xffffff) !== 0) hudNonBlack++;
          }
        }
        if (hudNonBlack < 500) hudBroken++;
      }
      assert.strictEqual(
        hudBroken, 0,
        `TMNT3 real Stage 1 HUD vanished/corrupted on ${hudBroken}/90 frames`
      );
    }
  }

  const btBin = findRom('battletoads');
  if (!btBin) return;
  const btCrc = computeRomCrc32(Buffer.from(btBin, 'binary'));
  const btSave = resolveSaveSlotPath(ROOT_DIR, btCrc, 1);
  if (!btSave) return;
  let fb = null;
  const nes = new jsnes.NES({ onFrame: (b) => { fb = b.slice(); } });
  nes.loadROM(btBin);
  patchJsnes8x16Sprites(nes);
  const eng = new NesNetplayEngine(nes, { localPlayer: 1, online: false });
  eng.importSyncState(JSON.parse(fs.readFileSync(btSave, 'utf8')).syncState);
  let hudVanished = 0;
  for (let f = 0; f < 90; f++) {
    const m1 = (f % 10 < 5 ? INPUT_BITS.RIGHT : INPUT_BITS.LEFT) |
      (f % 8 < 2 ? INPUT_BITS.B : 0);
    eng.stepNetplayFrame(m1, INPUT_BITS.LEFT);
    let topHudPx = 0;
    for (let y = 16; y < 32; y++) {
      for (let x = 16; x < 240; x++) {
        if ((fb[y * 256 + x] & 0xffffff) !== 0) topHudPx++;
      }
    }
    if (topHudPx < 300) hudVanished++;
  }
  assert.strictEqual(
    hudVanished, 0,
    `Battletoads Stage 1 HUD vanished on ${hudVanished}/90 gameplay frames`
  );
}

export function runVisualAccuracySuite() {
  console.log('=== Visual Pixel-Stability & Sprite Accuracy Suite ===\n');
  testBattletoadsTitleScanline87Stability();
  testBattletoadsCharacterSelectStability();
  testBattletoadsRollbackCrispPaletteNoFading();
  testOverflow12SpritesPerScanlineAllVisible();
  testTmnt3RealHudAndBattletoadsStage1Visuals();
  console.log(
    '[PASS] Battletoads Title/CharSelect/Stage1, Crisp Rollbacks, ' +
      '12-Sprite Overflow & Real TMNT3 HUD Visual Gates Verified'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)) {
  runVisualAccuracySuite();
}
