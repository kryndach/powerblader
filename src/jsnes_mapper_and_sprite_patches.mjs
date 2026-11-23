// Backward-Compatible Barrel for Composable Mapper, Sprite & Overclock Patches
export { patchFastMapperBankSwitching } from './mapper_bank_cache.mjs';
export {
  patch8x16SpriteRenderer, isCpuInTightWaitLoop, patchPostRenderOverclock,
  setNesOverclockEnabled
} from './ppu_sprite_and_overclock.mjs';
export { patchPpuHblankAndHeadless } from './ppu_hblank_and_headless.mjs';
