// Universal Room Secret & Auth Token Helpers (Browser WebCrypto & Node)
const ENC = new TextEncoder();

export async function sha256Bytes(data) {
  const bytes = typeof data === 'string' ? ENC.encode(data) : data;
  if (globalThis.crypto?.subtle) {
    const dig = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(dig);
  }
  const cryptoMod = await import('node:crypto');
  return new Uint8Array(cryptoMod.createHash('sha256').update(bytes).digest());
}

export function bytesToHex(u8) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const clean = String(hex || '').trim();
  const out = new Uint8Array(clean.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function sha256Hex(data) {
  return bytesToHex(await sha256Bytes(data));
}

export function normalizeRoomCode(room) {
  return String(room || 'NOVA').trim().toUpperCase().slice(0, 12) || 'NOVA';
}

export function deriveRoomSecret(room, password) {
  const pass = String(password || '').trim();
  if (!pass) return '';
  return `nes_room_v1:${normalizeRoomCode(room)}:${pass}`;
}

export async function deriveRoomAuthToken(room, password) {
  const pass = String(password || '').trim();
  if (!pass) return '';
  return sha256Hex(`nes_auth_v1:${normalizeRoomCode(room)}:${pass}`);
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.byteLength;
  }
  return out;
}
