import fs from 'fs';
import * as jsnesModule from 'jsnes';
const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;

const romPath = 'local/Power Blade 2 (U) [!].nes';
const romData = fs.readFileSync(romPath, { encoding: 'binary' });

const nes = new jsnes.NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(romData);

const oamOwner = new Int8Array(64).fill(-1);
const origCpuWrite = nes.cpu.write.bind(nes.cpu);
nes.cpu.write = function (addr, val) {
  if (addr >= 0x200 && addr < 0x300) {
    const slot = (addr - 0x200) >> 2;
    if ((addr & 3) === 0 && val >= 0xf0) {
      oamOwner[slot] = -1;
    } else if ((addr & 3) === 3) {
      oamOwner[slot] = this.mem[0x0d];
    }
  }
  return origCpuWrite(addr, val);
};

function advance(frames) {
  for (let i = 0; i < frames; i++) nes.frame();
}
function tap(btn, hold = 8, wait = 120) {
  nes.buttonDown(1, btn);
  advance(hold);
  nes.buttonUp(1, btn);
  advance(wait);
}

advance(360);
tap(jsnes.Controller.BUTTON_START, 8, 120);
tap(jsnes.Controller.BUTTON_START, 8, 180);
tap(jsnes.Controller.BUTTON_START, 8, 240);
tap(jsnes.Controller.BUTTON_START, 8, 180);

// Walk left 175 frames so Enemy #21 is on screen, and throw a boomerang!
nes.buttonDown(1, jsnes.Controller.BUTTON_LEFT);
advance(175);
nes.buttonUp(1, jsnes.Controller.BUTTON_LEFT);
nes.buttonDown(1, jsnes.Controller.BUTTON_B);
advance(6);
nes.buttonUp(1, jsnes.Controller.BUTTON_B);
advance(4);

console.log('f_spriteSize:', nes.ppu.f_spriteSize, 'f_spPatternTable:', nes.ppu.f_spPatternTable);
const byActor = {};
for (let s = 0; s < 64; s++) {
  const y = nes.cpu.mem[0x200 + s * 4];
  const tile = nes.cpu.mem[0x200 + s * 4 + 1];
  const attr = nes.cpu.mem[0x200 + s * 4 + 2];
  const x = nes.cpu.mem[0x200 + s * 4 + 3];
  if (y < 0xf0) {
    const owner = oamOwner[s];
    if (!byActor[owner]) byActor[owner] = [];
    byActor[owner].push({ s, x, y, tile, attr });
  }
}
console.log('OAM Sprites grouped by Actor Slot ($000D):');
for (const [actor, list] of Object.entries(byActor)) {
  console.log(`  Actor Slot ${actor} (type=${nes.cpu.mem[0x400 + Number(actor)]}, pos=${nes.cpu.mem[0x508 + Number(actor)]},${nes.cpu.mem[0x4c6 + Number(actor)]}): ${list.length} sprites ->`, list);
}
