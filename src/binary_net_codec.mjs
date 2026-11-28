// Compact 18-Byte Binary Codec for 60Hz Netplay Inputs & Pings (Browser+Node)
import { crc32Bytes } from './crc32.mjs';

export const BIN_MAGIC_INPUT = 0x4e; // 'N'
export const BIN_MAGIC_PING = 0x50;  // 'P'
export const BIN_MAGIC_PONG = 0x51;  // 'Q'
export const BIN_MAGIC_ROM_CHUNK = 0x52; // 'R'
const FLAG_HAS_HASH = 0x01;
const FLAG_WIDE_MASK = 0x02;

const sidHashCache = new Map();

export function hashSessionId32(sessionId) {
  const s = String(sessionId || 'default');
  let h = sidHashCache.get(s);
  if (h !== undefined) return h;
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  h = crc32Bytes(u8) >>> 0;
  if (sidHashCache.size > 64) sidHashCache.clear();
  sidHashCache.set(s, h);
  return h;
}

export function matchesBinarySessionId(pktSid, expectedSid) {
  if (!pktSid || !expectedSid || pktSid === expectedSid) return true;
  if (typeof pktSid === 'string' && pktSid.startsWith('bin_')) {
    return pktSid === `bin_${hashSessionId32(expectedSid).toString(16)}`;
  }
  return false;
}

function toUint8View(raw) {
  if (!raw) return null;
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}

export function isBinaryNetplayPacket(raw) {
  const u8 = toUint8View(raw);
  if (!u8 || u8.byteLength < 9) return false;
  const m = u8[0];
  return m === BIN_MAGIC_INPUT || m === BIN_MAGIC_PING || m === BIN_MAGIC_PONG;
}

export function encodePingBinary(type, t) {
  const buf = new Uint8Array(9);
  buf[0] = type === 'peer_pong' ? BIN_MAGIC_PONG : BIN_MAGIC_PING;
  new DataView(buf.buffer).setFloat64(1, Number(t) || Date.now(), true);
  return buf;
}

export function encodeNetplayPacketBinary(pkt) {
  if (pkt.type === 'peer_ping' || pkt.type === 'peer_pong') {
    return encodePingBinary(pkt.type, pkt.t);
  }
  const inputs = Array.isArray(pkt.inputs) ? pkt.inputs : [];
  const pairs = [];
  let wide = false;
  for (let i = 0; i < inputs.length; ) {
    const val = (inputs[i] >>> 0) & 0xffff;
    if (val > 255) wide = true;
    let run = 1;
    while (
      i + run < inputs.length &&
      ((inputs[i + run] >>> 0) & 0xffff) === val &&
      run < 255
    ) {
      run++;
    }
    pairs.push(val, run);
    i += run;
    if (pairs.length >= 510) break;
  }
  const extraTail = pkt.tailCount > inputs.length
    ? Math.floor(pkt.tailCount) - inputs.length : 0;
  if (extraTail > 0 && pairs.length >= 2) {
    const lastVal = pairs[pairs.length - 2];
    let rem = extraTail;
    const add = Math.min(255 - pairs[pairs.length - 1], rem);
    pairs[pairs.length - 1] += add;
    rem -= add;
    while (rem > 0 && pairs.length < 510) {
      const chunk = Math.min(255, rem);
      pairs.push(lastVal, chunk);
      rem -= chunk;
    }
  }
  const hasHash =
    typeof pkt.hashFrame === 'number' && typeof pkt.hash === 'number';
  const pairCnt = pairs.length >>> 1;
  const pairBytes = pairCnt * (wide ? 3 : 2);
  const totalLen = 16 + pairBytes + (hasHash ? 8 : 0);
  const out = new Uint8Array(totalLen);
  const dv = new DataView(out.buffer);
  out[0] = BIN_MAGIC_INPUT;
  out[1] = (hasHash ? FLAG_HAS_HASH : 0) | (wide ? FLAG_WIDE_MASK : 0);
  dv.setUint32(2, hashSessionId32(pkt.sessionId), true);
  const sf = Math.max(0, Math.floor(pkt.startFrame || 0)) >>> 0;
  dv.setUint32(6, sf, true);
  const rawAckDelta = typeof pkt.ack === 'number' && Number.isFinite(pkt.ack)
    ? sf - Math.floor(pkt.ack)
    : null;
  const ackDelta =
    rawAckDelta !== null && rawAckDelta >= -32767 && rawAckDelta <= 32767
      ? rawAckDelta
      : -32768;
  dv.setInt16(10, ackDelta, true);
  const lead = typeof pkt.peerLead === 'number' && Number.isFinite(pkt.peerLead)
    ? Math.max(-127, Math.min(127, Math.round(pkt.peerLead)))
    : -128;
  dv.setInt8(12, lead);
  const clumpQ = Math.max(
    0, Math.min(255, Math.round((pkt.rxClump || 0) * 16))
  );
  out[13] = clumpQ;
  out[14] = Math.max(0, Math.min(255, Math.floor(pkt.inputDelay || 0)));
  out[15] = pairCnt;
  let off = 16;
  for (let i = 0; i < pairs.length; i += 2) {
    if (wide) {
      dv.setUint16(off, pairs[i], true);
      off += 2;
    } else {
      out[off++] = pairs[i] & 0xff;
    }
    out[off++] = pairs[i + 1] & 0xff;
  }
  if (hasHash) {
    dv.setUint32(off, Math.max(0, Math.floor(pkt.hashFrame)) >>> 0, true);
    dv.setUint32(off + 4, pkt.hash >>> 0, true);
  }
  return out;
}

export function decodeNetplayPacketBinary(raw, expectedSessionId = null) {
  const u8 = toUint8View(raw);
  if (!u8 || u8.byteLength < 9) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = u8[0];
  if (magic === BIN_MAGIC_PING || magic === BIN_MAGIC_PONG) {
    return {
      type: magic === BIN_MAGIC_PONG ? 'peer_pong' : 'peer_ping',
      t: dv.getFloat64(1, true)
    };
  }
  if (magic !== BIN_MAGIC_INPUT || u8.byteLength < 16) return null;
  const flags = u8[1];
  const hasHash = Boolean(flags & FLAG_HAS_HASH);
  const wide = Boolean(flags & FLAG_WIDE_MASK);
  const sidHash = dv.getUint32(2, true);
  const startFrame = dv.getUint32(6, true);
  const ackDelta = dv.getInt16(10, true);
  const lead = dv.getInt8(12);
  const rxClump = Number((u8[13] / 16).toFixed(2));
  const inputDelay = u8[14];
  const pairCnt = u8[15];
  const need = 16 + pairCnt * (wide ? 3 : 2) + (hasHash ? 8 : 0);
  if (u8.byteLength < need) return null;

  const inputs = [];
  let off = 16;
  for (let i = 0; i < pairCnt; i++) {
    const val = wide ? dv.getUint16(off, true) : u8[off];
    off += wide ? 2 : 1;
    const run = u8[off++];
    for (let k = 0; k < run && inputs.length < 256; k++) inputs.push(val);
  }
  const sessionId =
    expectedSessionId && hashSessionId32(expectedSessionId) === sidHash
      ? expectedSessionId
      : `bin_${sidHash.toString(16)}`;
  const msg = {
    type: 'netplay_input', sessionId, startFrame, inputs, rxClump, inputDelay
  };
  if (ackDelta !== -32768) msg.ack = Math.max(-1, startFrame - ackDelta);
  if (lead !== -128) msg.peerLead = lead;
  if (hasHash) {
    msg.hashFrame = dv.getUint32(off, true);
    msg.hash = dv.getUint32(off + 4, true);
  }
  return msg;
}

export function extractBinaryInputDedupKey(raw) {
  const u8 = toUint8View(raw);
  if (!u8 || u8.byteLength < 16 || u8[0] !== BIN_MAGIC_INPUT) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const flags = u8[1];
  const wide = Boolean(flags & FLAG_WIDE_MASK);
  const hasHash = Boolean(flags & FLAG_HAS_HASH);
  const sidHash = dv.getUint32(2, true);
  const startFrame = dv.getUint32(6, true);
  const pairCnt = u8[15];
  const hashOff = 16 + pairCnt * (wide ? 3 : 2);
  const need = hashOff + (hasHash ? 8 : 0);
  if (u8.byteLength < need) return null;
  const firstMask = pairCnt > 0
    ? (wide ? dv.getUint16(16, true) : u8[16]) : 0;
  const hf = hasHash ? dv.getUint32(hashOff, true) : '';
  return {
    dedupKey: `b:${sidHash}:${startFrame}:${firstMask}:${hf}`,
    sidHash, startFrame, hasHash
  };
}

export function isBinaryRomChunk(raw) {
  const u8 = toUint8View(raw);
  return Boolean(u8 && u8.byteLength >= 9 && u8[0] === BIN_MAGIC_ROM_CHUNK);
}

export function encodeBinaryRomChunk(sessionId, index, sliceU8) {
  const out = new Uint8Array(9 + sliceU8.byteLength);
  const dv = new DataView(out.buffer);
  out[0] = BIN_MAGIC_ROM_CHUNK;
  dv.setUint32(1, hashSessionId32(sessionId), true);
  dv.setUint32(5, Math.max(0, Math.floor(index || 0)) >>> 0, true);
  out.set(sliceU8, 9);
  return out;
}

export function decodeBinaryRomChunk(raw, expectedSessionId = null) {
  const u8 = toUint8View(raw);
  if (!u8 || u8.byteLength < 9 || u8[0] !== BIN_MAGIC_ROM_CHUNK) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sidHash = dv.getUint32(1, true);
  const index = dv.getUint32(5, true);
  const sessionId =
    expectedSessionId && hashSessionId32(expectedSessionId) === sidHash
      ? expectedSessionId
      : `bin_${sidHash.toString(16)}`;
  return {
    type: 'rom_chunk_data', sessionId, index,
    data: u8.subarray(9)
  };
}
