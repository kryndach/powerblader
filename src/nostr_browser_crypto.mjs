// Universal Browser + Node BIP-340 Schnorr & AES-256-GCM Nostr Signaling Crypto
import {
  sha256Bytes, bytesToHex, hexToBytes, concatBytes
} from './room_auth.mjs';

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
const ENC = new TextEncoder();
const DEC = new TextDecoder();

const mod = (a, m = P) => ((a % m) + m) % m;

function modPow(base, exp, m = P) {
  let r = 1n, b = mod(base, m), e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

const modInv = (a, m = P) => modPow(a, m - 2n, m);

function pointAdd(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x) {
    if (a.y !== b.y || a.y === 0n) return null;
    const lam = mod(3n * a.x * a.x * modInv(2n * a.y));
    const x = mod(lam * lam - 2n * a.x);
    return { x, y: mod(lam * (a.x - x) - a.y) };
  }
  const lam = mod((b.y - a.y) * modInv(b.x - a.x));
  const x = mod(lam * lam - a.x - b.x);
  return { x, y: mod(lam * (a.x - x) - a.y) };
}

function pointMul(k, pt = { x: GX, y: GY }) {
  let r = null, add = pt, n = mod(k, N);
  while (n > 0n) {
    if (n & 1n) r = pointAdd(r, add);
    add = pointAdd(add, add);
    n >>= 1n;
  }
  return r;
}

const u8ToBig = (u8) => BigInt('0x' + bytesToHex(u8));
const bigTo32 = (v, m = P) =>
  hexToBytes(mod(v, m).toString(16).padStart(64, '0'));

async function taggedHash(tag, ...parts) {
  const th = await sha256Bytes(ENC.encode(tag));
  return sha256Bytes(concatBytes(th, th, ...parts));
}

async function getRandomBytes(n) {
  const out = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(out);
    return out;
  }
  const c = await import('node:crypto');
  return new Uint8Array(c.randomBytes(n));
}

async function getSubtle() {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  const c = await import('node:crypto');
  return c.webcrypto.subtle;
}

function toBase64(u8) {
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
  }
  return Buffer.from(u8).toString('base64');
}

function fromBase64(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export async function deriveUniversalKeys(secret, tagSuffix = '') {
  const norm = String(secret || '').trim();
  if (norm.length < 4) throw new Error('Room secret too short');
  let priv = await sha256Bytes(`nes_online_nostr_priv_v1:${norm}`);
  if (u8ToBig(priv) >= N || u8ToBig(priv) === 0n) {
    priv = await sha256Bytes(concatBytes(priv, ENC.encode('rehash')));
  }
  const pt = pointMul(u8ToBig(priv));
  const pubkey = bytesToHex(bigTo32(pt.x, P));
  const aesRaw = await sha256Bytes(`nes_online_aes_v1:${norm}`);
  const dRaw = await sha256Bytes(`nes_online_dtag_v1:${norm}`);
  const dTag = `${bytesToHex(dRaw).slice(0, 24)}${tagSuffix}`;
  return { priv, pubkey, aesRaw, dTag };
}

export async function encryptJsonAesGcm(obj, aesRaw) {
  const subtle = await getSubtle();
  const iv = await getRandomBytes(12);
  const key = await subtle.importKey(
    'raw', aesRaw, 'AES-GCM', false, ['encrypt']
  );
  const pt = ENC.encode(JSON.stringify(obj));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, key, pt)
  );
  return toBase64(concatBytes(iv, ct));
}

export async function decryptJsonAesGcm(b64, aesRaw) {
  const raw = fromBase64(b64);
  if (raw.length < 29) throw new Error('Ciphertext too short');
  const subtle = await getSubtle();
  const key = await subtle.importKey(
    'raw', aesRaw, 'AES-GCM', false, ['decrypt']
  );
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12)
  );
  return JSON.parse(DEC.decode(pt));
}

export async function signUniversalNostrEvent(payloadObj, keys, nowSec = null) {
  const created_at = nowSec ?? Math.floor(Date.now() / 1000);
  const kind = 30078;
  const tags = [['d', keys.dTag]];
  const content = await encryptJsonAesGcm(payloadObj, keys.aesRaw);
  const pre = JSON.stringify([0, keys.pubkey, created_at, kind, tags, content]);
  const idBytes = await sha256Bytes(ENC.encode(pre));
  const id = bytesToHex(idBytes);

  const d0 = u8ToBig(keys.priv);
  const pt = pointMul(d0);
  const d = (pt.y & 1n) === 0n ? d0 : N - d0;
  const px = bigTo32(pt.x, P);
  const aux = await getRandomBytes(32);
  const t = d ^ u8ToBig(await taggedHash('BIP0340/aux', aux));
  const rand = await taggedHash('BIP0340/nonce', bigTo32(t, N), px, idBytes);
  const k0 = u8ToBig(rand) % N;
  const R = pointMul(k0);
  const k = (R.y & 1n) === 0n ? k0 : N - k0;
  const rx = bigTo32(R.x, P);
  const e = u8ToBig(await taggedHash('BIP0340/challenge', rx, px, idBytes)) % N;
  const s = (k + e * d) % N;
  const sig = bytesToHex(concatBytes(rx, bigTo32(s, N)));
  return { id, pubkey: keys.pubkey, created_at, kind, tags, content, sig };
}
