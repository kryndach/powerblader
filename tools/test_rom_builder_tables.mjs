/**
 * @fileoverview Synthetic Dual-Controller iNES ROM Builder for Automated QA
 * Tests (Mappers 0, 1, 2, 4).
 *
 * Line width <= 80 chars, file size <= 350 lines.
 */

import fs from 'fs';
import path from 'path';

/**
 * Builds a minimal valid iNES ROM with a 6502 NMI/main loop that reads
 * both Controller 1 ($4016) and Controller 2 ($4017) every frame, stores
 * the 8-bit button masks at $0010 (P1) and $0011 (P2), and updates
 * deterministic game state in RAM ($0020-$03FF) and PPU VRAM.
 */
export function createDualControllerTestRom(mapperId = 0) {
  const prgBanks = mapperId === 4 ? 2 : 1; // 16KB units
  const chrBanks = mapperId === 2 ? 0 : 1; // 8KB units (Mapper 2 = CHR-RAM)
  const header = new Uint8Array(16);
  header[0] = 0x4e; // 'N'
  header[1] = 0x45; // 'E'
  header[2] = 0x53; // 'S'
  header[3] = 0x1a;
  header[4] = prgBanks;
  header[5] = chrBanks;
  header[6] = (mapperId & 0x0f) << 4;
  header[7] = mapperId & 0xf0;

  const prgSize = prgBanks * 16384;
  const prg = new Uint8Array(prgSize).fill(0xea); // NOP

  // Assemble 6502 test program at $C000 (last 16KB bank)
  const baseOffset = prgSize - 16384;
  let pc = baseOffset;
  const emit = (...bytes) => {
    for (const b of bytes) prg[pc++] = b & 0xff;
  };

  // $C000: RESET handler (SEI; CLD; LDX #$FF; TXS; BIT $2002)
  emit(0x78, 0xd8, 0xa2, 0xff, 0x9a, 0x2c, 0x02, 0x20);
  // Load non-zero PPU palette ($3F00 = $0F, $3F01 = $30)
  emit(0xa9, 0x3f, 0x8d, 0x06, 0x20, 0xa9, 0x00, 0x8d, 0x06, 0x20);
  emit(0xa9, 0x0f, 0x8d, 0x07, 0x20, 0xa9, 0x30, 0x8d, 0x07, 0x20);
  // Enable NMI ($2000 = $80) and BG+Sprites ($2001 = $1E)
  emit(0xa9, 0x80, 0x8d, 0x00, 0x20, 0xa9, 0x1e, 0x8d, 0x01, 0x20);
  // Infinite main loop at $C028: INC $00; JMP $C028
  while (pc < baseOffset + 0x28) emit(0xea);
  emit(0xe6, 0x00, 0x4c, 0x28, 0xc0);

  // $C040: NMI handler (runs once per frame at VBlank)
  pc = baseOffset + 0x40;
  emit(0x48, 0x8a, 0x48, 0x98, 0x48);

  // Strobe controllers: LDA #$01; STA $4016; LDA #$00; STA $4016
  emit(0xa9, 0x01, 0x8d, 0x16, 0x40, 0xa9, 0x00, 0x8d, 0x16, 0x40);

  // Read 8 bits from $4016 into $0010 (P1) and $4017 into $0011 (P2)
  emit(0xa2, 0x08);
  const loopStart = pc;
  emit(0xad, 0x16, 0x40, 0x4a, 0x66, 0x10);
  emit(0xad, 0x17, 0x40, 0x4a, 0x66, 0x11);
  const rel = (loopStart - (pc + 2)) & 0xff;
  emit(0xca, 0xd0, rel);

  // Update P1 X/Y ($0020) and P2 X/Y ($0022) from $10 and $11
  emit(0xa5, 0x20, 0x18, 0x65, 0x10, 0x85, 0x20);
  emit(0xa5, 0x22, 0x18, 0x65, 0x11, 0x85, 0x22);
  emit(0xe6, 0x30);

  // PLA; TAY; PLA; TAX; PLA; RTI
  emit(0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40);

  // Vectors at $FFFA-$FFFF
  const vecOffset = prgSize - 6;
  prg[vecOffset + 0] = 0x40; // NMI lo ($C040)
  prg[vecOffset + 1] = 0xc0; // NMI hi
  prg[vecOffset + 2] = 0x00; // RESET lo ($C000)
  prg[vecOffset + 3] = 0xc0; // RESET hi
  prg[vecOffset + 4] = 0x40; // IRQ lo
  prg[vecOffset + 5] = 0xc0; // IRQ hi

  const chrSize = chrBanks * 8192;
  const chr = new Uint8Array(chrSize);
  for (let i = 0; i < chrSize; i++) chr[i] = (i * 7) & 0xff;

  const total = new Uint8Array(16 + prgSize + chrSize);
  total.set(header, 0);
  total.set(prg, 16);
  total.set(chr, 16 + prgSize);

  let binStr = '';
  for (let i = 0; i < total.length; i++) {
    binStr += String.fromCharCode(total[i]);
  }
  return { uint8: total, binaryString: binStr };
}

export function loadLocalOrSyntheticNesRom(localDir, substr = '', mapper = 0) {
  const nesDir = fs.existsSync(path.join(localDir, 'nes'))
    ? path.join(localDir, 'nes') : localDir;
  if (fs.existsSync(nesDir)) {
    const files = fs.readdirSync(nesDir)
      .filter((f) => f.toLowerCase().endsWith('.nes')).sort();
    const pick = (substr
      ? files.find((f) => f.toLowerCase().includes(substr.toLowerCase()))
      : null) || files[0];
    if (pick) {
      const buf = fs.readFileSync(path.join(nesDir, pick));
      return {
        name: pick, uint8: new Uint8Array(buf),
        binaryString: buf.toString('binary'), isSynthetic: false
      };
    }
  }
  const syn = createDualControllerTestRom(mapper);
  return {
    name: `synthetic_m${mapper}.nes`, uint8: syn.uint8,
    binaryString: syn.binaryString, isSynthetic: true
  };
}

export function writeSyntheticNesRomSet(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const specs = [
    ['synthetic_m0.nes', 0], ['synthetic_m2_chrram.nes', 2],
    ['synthetic_m4_mmc3.nes', 4]
  ];
  for (const [name, m] of specs) {
    fs.writeFileSync(path.join(dir, name), createDualControllerTestRom(m).uint8);
  }
  return specs.map(([name]) => name);
}

export function buildFileUploadJs(u8, fileName, mime = 'application/octet-stream') {
  const b64 = Buffer.from(u8).toString('base64');
  return `(() => {
    const s = atob(${JSON.stringify(b64)}), u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mime)} }));
    const inp = document.getElementById('romFileInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return u.byteLength;
  })()`;
}
