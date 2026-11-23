// jsnes Fast PRG/CHR Mapper Bank Caching & MMC3 Register Tracking
export function patchFastMapperBankSwitching(mmap) {
  if (!mmap || mmap._fastBankPatched) return;
  mmap._fastBankPatched = true;
  mmap._bankAt8000 = -1;
  mmap._bankAtC000 = -1;
  mmap._vromAt0000 = -1;
  mmap._vromAt1000 = -1;

  mmap.loadRomBank = function (bank, address) {
    const romCount = this.nes.rom ? this.nes.rom.romCount : 0;
    if (!romCount) return;
    bank %= romCount;
    if (address === 0x8000) {
      if (this._bankAt8000 === bank) return;
      this._bankAt8000 = bank;
    } else if (address === 0xc000) {
      if (this._bankAtC000 === bank) return;
      this._bankAtC000 = bank;
    }
    this.nes.cpu.mem.set(this.nes.rom.rom[bank], address);
  };

  mmap.load32kRomBank = function (bank, address) {
    const romCount = this.nes.rom ? this.nes.rom.romCount : 0;
    if (!romCount) return;
    const b0 = (bank * 2) % romCount;
    const b1 = (bank * 2 + 1) % romCount;
    if (
      address === 0x8000 &&
      this._bankAt8000 === b0 &&
      this._bankAtC000 === b1
    ) {
      return;
    }
    if (address === 0x8000) {
      this._bankAt8000 = b0;
      this._bankAtC000 = b1;
    }
    this.nes.cpu.mem.set(this.nes.rom.rom[b0], address);
    this.nes.cpu.mem.set(this.nes.rom.rom[b1], address + 16384);
  };

  mmap.load8kRomBank = function (bank8k, address) {
    const romCount = this.nes.rom ? this.nes.rom.romCount : 0;
    if (!romCount) return;
    this._bankAt8000 = -1;
    this._bankAtC000 = -1;
    const bank16k = (bank8k >> 1) % romCount;
    const offset = (bank8k & 1) << 13;
    const slice = this.nes.rom.rom[bank16k].subarray(offset, offset + 8192);
    this.nes.cpu.mem.set(slice, address);
  };

  mmap.loadVromBank = function (bank, address) {
    const vromCount = this.nes.rom ? this.nes.rom.vromCount : 0;
    if (vromCount === 0) return;
    const b = bank % vromCount;
    if (address === 0x0000) {
      if (this._vromAt0000 === b) return;
      this._vromAt0000 = b;
    } else if (address === 0x1000) {
      if (this._vromAt1000 === b) return;
      this._vromAt1000 = b;
    }
    this.nes.ppu.triggerRendering();
    this.nes.ppu.vramMem.set(this.nes.rom.vrom[b], address);
    const vromTile = this.nes.rom.vromTile[b];
    const baseIndex = address >> 4;
    const ptTile = this.nes.ppu.ptTile;
    for (let i = 0; i < 256; i++) ptTile[baseIndex + i] = vromTile[i];
  };

  mmap.load8kVromBank = function (bank4kStart, address) {
    const vromCount = this.nes.rom ? this.nes.rom.vromCount : 0;
    if (vromCount === 0) return;
    this.loadVromBank(bank4kStart % vromCount, address);
    this.loadVromBank((bank4kStart + 1) % vromCount, address + 4096);
  };

  mmap.load1kVromBank = function (bank1k, address) {
    const vromCount = this.nes.rom ? this.nes.rom.vromCount : 0;
    if (vromCount === 0) return;
    this._vromAt0000 = -1;
    this._vromAt1000 = -1;
    this.nes.ppu.triggerRendering();
    const bank4k = Math.floor(bank1k / 4) % vromCount;
    const off = (bank1k % 4) * 1024;
    const slice = this.nes.rom.vrom[bank4k].subarray(off, off + 1024);
    this.nes.ppu.vramMem.set(slice, address);
    const vromTile = this.nes.rom.vromTile[bank4k];
    const baseIndex = address >> 4;
    const tileOff = (bank1k % 4) << 6;
    const ptTile = this.nes.ppu.ptTile;
    for (let i = 0; i < 64; i++) ptTile[baseIndex + i] = vromTile[tileOff + i];
  };

  mmap.load2kVromBank = function (bank2k, address) {
    const vromCount = this.nes.rom ? this.nes.rom.vromCount : 0;
    if (vromCount === 0) return;
    this._vromAt0000 = -1;
    this._vromAt1000 = -1;
    this.nes.ppu.triggerRendering();
    const bank4k = Math.floor(bank2k / 2) % vromCount;
    const off = (bank2k % 2) * 2048;
    const slice = this.nes.rom.vrom[bank4k].subarray(off, off + 2048);
    this.nes.ppu.vramMem.set(slice, address);
    const vromTile = this.nes.rom.vromTile[bank4k];
    const baseIndex = address >> 4;
    const tileOff = (bank2k % 2) << 7;
    const ptTile = this.nes.ppu.ptTile;
    for (let i = 0; i < 128; i++) ptTile[baseIndex + i] = vromTile[tileOff + i];
  };

  if (typeof mmap.executeCommand === 'function') {
    mmap._mmc3Regs = [0, 2, 4, 5, 6, 7, 0, 1];
    const origExec = mmap.executeCommand.bind(mmap);
    mmap.executeCommand = function (cmd, arg) {
      if (cmd >= 0 && cmd < 8) this._mmc3Regs[cmd] = arg;
      return origExec(cmd, arg);
    };

    const origWrite = mmap.write.bind(mmap);
    mmap.write = function (address, value) {
      if (address >= 0x8000 && (address & 0xe001) === 0x8000) {
        this.command = value & 7;
        const newPrg = (value >> 6) & 1;
        const newChr = (value >> 7) & 1;
        const prgDiff = newPrg !== this.prgAddressSelect;
        const chrDiff = newChr !== this.chrAddressSelect;
        this.prgAddressSelect = newPrg;
        this.chrAddressSelect = newChr;
        this.prgAddressChanged = false;
        if (prgDiff && this.nes.rom && this.nes.rom.romCount > 0) {
          const fixedBank = (this.nes.rom.romCount - 1) * 2;
          const r6 = this._mmc3Regs[6];
          if (newPrg === 0) {
            this.load8kRomBank(r6, 0x8000);
            this.load8kRomBank(fixedBank, 0xc000);
          } else {
            this.load8kRomBank(fixedBank, 0x8000);
            this.load8kRomBank(r6, 0xc000);
          }
        }
        if (chrDiff && this.nes.rom && this.nes.rom.vromCount > 0) {
          for (let c = 0; c < 6; c++) origExec(c, this._mmc3Regs[c]);
        }
        return;
      }
      return origWrite(address, value);
    };

    const origToJSON = mmap.toJSON.bind(mmap);
    mmap.toJSON = function () {
      const s = origToJSON();
      s._mmc3Regs = this._mmc3Regs.slice();
      return s;
    };

    const origFromJSON = mmap.fromJSON.bind(mmap);
    mmap.fromJSON = function (s) {
      origFromJSON(s);
      if (s && Array.isArray(s._mmc3Regs)) {
        this._mmc3Regs = s._mmc3Regs.slice();
      }
    };
  }
}
