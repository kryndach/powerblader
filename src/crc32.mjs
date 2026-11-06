/**
 * Fast CRC32, Hex Formatting, Base64 & Deterministic NES State Hash.
 * Line width <= 80 chars, file size <= 350 lines.
 */

export const INPUT_BITS = {
  A: 1 << 0,
  B: 1 << 1,
  SELECT: 1 << 2,
  START: 1 << 3,
  UP: 1 << 4,
  DOWN: 1 << 5,
  LEFT: 1 << 6,
  RIGHT: 1 << 7
};

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

export function crc32Bytes(
  bytes,
  start = 0,
  length = bytes.length - start,
  seed = 0
) {
  let crc = (seed ^ 0xffffffff) >>> 0;
  const end = start + length;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ (bytes[i] & 0xff)) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function computeRomCrc32(romBinaryStringOrUint8) {
  let crc = 0xffffffff;
  if (typeof romBinaryStringOrUint8 === 'string') {
    for (let i = 0; i < romBinaryStringOrUint8.length; i++) {
      const byte = romBinaryStringOrUint8.charCodeAt(i) & 0xff;
      crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  } else {
    for (let i = 0; i < romBinaryStringOrUint8.length; i++) {
      const byte = romBinaryStringOrUint8[i] & 0xff;
      crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0)
    .toString(16)
    .toUpperCase()
    .padStart(8, '0');
}

export const crc32Hex = computeRomCrc32;

export function formatHex32(val) {
  return (val >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export function uint8ToBase64(u8) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString(
      'base64'
    );
  }
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + step));
  }
  return btoa(bin);
}

export function base64ToUint8(b64) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 0xff;
  return u8;
}

/**
 * Computes a deterministic 32-bit CRC32 of NES 2KB CPU RAM ($0000-$07FF),
 * CPU registers (PC, A, X, Y, SP), and PPU nametable/palette VRAM
 * ($2000-$3FFF).
 */
export function computeDeterministicHash(nes) {
  let crc = crc32Bytes(nes.cpu.mem, 0, 0x0800, 0);
  const regBytes = new Uint8Array([
    nes.cpu.REG_PC & 0xff,
    (nes.cpu.REG_PC >> 8) & 0xff,
    nes.cpu.REG_ACC & 0xff,
    nes.cpu.REG_X & 0xff,
    nes.cpu.REG_Y & 0xff,
    nes.cpu.REG_SP & 0xff
  ]);
  crc = crc32Bytes(regBytes, 0, regBytes.length, crc);
  crc = crc32Bytes(nes.ppu.vramMem, 0x2000, 0x2000, crc);
  return crc >>> 0;
}
