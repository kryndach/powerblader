// Composable Facade for jsnes PPU Accuracy, Sprite Overflow & Mapper Caching
import { patchFastMapperBankSwitching } from './mapper_bank_cache.mjs';
import {
  patch8x16SpriteRenderer, patchPostRenderOverclock
} from './ppu_sprite_and_overclock.mjs';
import { patchPpuHblankAndHeadless } from './ppu_hblank_and_headless.mjs';

function tagVromTiles(rom) {
  if (!rom || rom._vromRefTagged || !(rom.vromCount > 0) ||
      !Array.isArray(rom.vromTile)) {
    return;
  }
  rom._vromRefTagged = true;
  for (let b = 0; b < rom.vromTile.length; b++) {
    const bank = rom.vromTile[b];
    if (!bank) continue;
    for (let t = 0; t < bank.length; t++) {
      if (bank[t]) bank[t]._vromRef = (b << 8) | (t & 0xff);
    }
  }
}

export function patchJsnes8x16Sprites(nes) {
  if (!nes) return;

  if (!nes._patchedLoadRomHook) {
    nes._patchedLoadRomHook = true;
    if (typeof nes.loadROM === 'function') {
      const origLoadROM = nes.loadROM.bind(nes);
      nes.loadROM = function (data) {
        const res = origLoadROM(data);
        patchJsnes8x16Sprites(this);
        return res;
      };
    }
    if (typeof nes.reset === 'function') {
      const origReset = nes.reset.bind(nes);
      nes.reset = function () {
        const res = origReset();
        patchJsnes8x16Sprites(this);
        return res;
      };
    }
  }

  tagVromTiles(nes.rom);
  patchFastMapperBankSwitching(nes.mmap);
  patchPostRenderOverclock(nes);

  if (!nes.ppu) return;
  if (nes.ppu._patched8x16) return;
  nes.ppu._patched8x16 = true;
  patchPpuHblankAndHeadless(nes.ppu);
  patch8x16SpriteRenderer(nes.ppu);
}
