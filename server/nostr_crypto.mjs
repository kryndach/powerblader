// Zero-Dependency BIP-340 Schnorr (secp256k1) & AES-256-GCM Beacon Crypto
import crypto from 'crypto';

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
const SQRT_EXP = (P + 1n) >> 2n;

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

function liftX(x) {
  if (x >= P) return null;
  const c = mod(modPow(x, 3n) + 7n);
  const y = modPow(c, SQRT_EXP);
  if (mod(y * y) !== c) return null;
  return { x, y: (y & 1n) === 0n ? y : P - y };
}

const bytesToBig = (buf) => BigInt('0x' + Buffer.from(buf).toString('hex'));
const bigToBytes32 = (v) =>
  Buffer.from(mod(v, P).toString(16).padStart(64, '0'), 'hex');
const bigNToBytes32 = (v) =>
  Buffer.from(mod(v, N).toString(16).padStart(64, '0'), 'hex');

function sha256(...chunks) {
  const h = crypto.createHash('sha256');
  for (const c of chunks) h.update(c);
  return h.digest();
}

function taggedHash(tag, ...chunks) {
  const th = sha256(Buffer.from(tag, 'utf8'));
  return sha256(th, th, ...chunks);
}

export function getPublicKeyHex(privKeyBuf) {
  const pt = pointMul(bytesToBig(privKeyBuf));
  return bigToBytes32(pt.x).toString('hex');
}

export function signBip340(msg32, privKeyBuf, aux32 = crypto.randomBytes(32)) {
  const d0 = bytesToBig(privKeyBuf);
  if (d0 <= 0n || d0 >= N) throw new Error('Invalid secp256k1 private key');
  const pt = pointMul(d0);
  const d = (pt.y & 1n) === 0n ? d0 : N - d0;
  const px = bigToBytes32(pt.x);
  const t = d ^ bytesToBig(taggedHash('BIP0340/aux', aux32));
  const rand = taggedHash('BIP0340/nonce', bigNToBytes32(t), px, msg32);
  const k0 = bytesToBig(rand) % N;
  if (k0 === 0n) throw new Error('Zero nonce in BIP-340');
  const R = pointMul(k0);
  const k = (R.y & 1n) === 0n ? k0 : N - k0;
  const rx = bigToBytes32(R.x);
  const e = bytesToBig(taggedHash('BIP0340/challenge', rx, px, msg32)) % N;
  const s = (k + e * d) % N;
  return Buffer.concat([rx, bigNToBytes32(s)]).toString('hex');
}

export function verifyBip340(msg32, pubKeyHex, sigHex) {
  const pubBuf = Buffer.from(pubKeyHex, 'hex');
  const sigBuf = Buffer.from(sigHex, 'hex');
  if (pubBuf.length !== 32 || sigBuf.length !== 64) return false;
  const pt = liftX(bytesToBig(pubBuf));
  if (!pt) return false;
  const r = bytesToBig(sigBuf.subarray(0, 32));
  const s = bytesToBig(sigBuf.subarray(32, 64));
  if (r >= P || s >= N) return false;
  const e = bytesToBig(
    taggedHash('BIP0340/challenge', sigBuf.subarray(0, 32), pubBuf, msg32)
  ) % N;
  const R = pointAdd(pointMul(s), pointMul(N - e, pt));
  return Boolean(R && (R.y & 1n) === 0n && R.x === r);
}

export function deriveRendezvousKeys(secret) {
  const norm = String(secret || '').trim();
  if (norm.length < 8) throw new Error('Rendezvous secret too short');
  let priv = sha256(`nes_online_nostr_priv_v1:${norm}`);
  if (bytesToBig(priv) >= N || bytesToBig(priv) === 0n) {
    priv = sha256(priv, Buffer.from('rehash'));
  }
  const pubkey = getPublicKeyHex(priv);
  const aesKey = sha256(`nes_online_aes_v1:${norm}`);
  const dTag = sha256(`nes_online_dtag_v1:${norm}`)
    .toString('hex').slice(0, 24);
  return { priv, pubkey, aesKey, dTag };
}

export function encryptBeaconPayload(obj, aesKeyBuf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKeyBuf, iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(obj), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

export function decryptBeaconPayload(b64, aesKeyBuf) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < 29) throw new Error('Encrypted beacon too short');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const dec = crypto.createDecipheriv('aes-256-gcm', aesKeyBuf, iv);
  dec.setAuthTag(tag);
  const pt = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  return JSON.parse(pt);
}

export function createSignedBeaconEvent(payloadObj, keys, nowSec = null) {
  const created_at = nowSec ?? Math.floor(Date.now() / 1000);
  const kind = 30078;
  const tags = [['d', keys.dTag]];
  const content = encryptBeaconPayload(payloadObj, keys.aesKey);
  const preimage = JSON.stringify([
    0, keys.pubkey, created_at, kind, tags, content
  ]);
  const idBuf = sha256(Buffer.from(preimage, 'utf8'));
  const id = idBuf.toString('hex');
  const sig = signBip340(idBuf, keys.priv);
  return { id, pubkey: keys.pubkey, created_at, kind, tags, content, sig };
}
