// Shared STUN/TURN ICE Profile Matrix, CRC32 & Stat Helpers for AutoTest/NetDebug
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}

export function crc32Bytes(u8) {
  let crc = 0xffffffff;
  for (let i = 0; i < u8.length; i++) {
    crc = CRC_TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export function uint8ToBase64(u8) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + step));
  }
  return btoa(bin);
}

export function base64ToUint8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function calcStats(arr) {
  const valid = arr.filter((x) => typeof x === 'number' && !isNaN(x));
  if (valid.length === 0) {
    return {
      count: 0,
      min: null,
      avg: null,
      med: null,
      p95: null,
      max: null,
      jitter: 0
    };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / sorted.length);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const med = sorted[Math.floor(sorted.length * 0.5)];
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[p95Idx];
  let jitSum = 0;
  for (let i = 1; i < valid.length; i++) {
    jitSum += Math.abs(valid[i] - valid[i - 1]);
  }
  const jitter = valid.length > 1 ? Math.round(jitSum / (valid.length - 1)) : 0;
  return { count: valid.length, min, avg, med, p95, max, jitter };
}

export const WEBRTC_PROFILES = [
  {
    id: 'zapret_discord',
    name: '1. Zapret/Discord UDP Ports (19302, 19305, 443 STUN)',
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19305' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun.nextcloud.com:443' }
    ]
  },
  {
    id: 'ru_sip',
    name: '2. RU/SIP + Cloudflare STUN (sipnet.ru, zadarma, cloudflare)',
    iceServers: [
      { urls: 'stun:stun.sipnet.ru:3478' },
      { urls: 'stun:stun.zadarma.com:3478' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  },
  {
    id: 'turn_relay',
    name: '3. Public TURN Relay UDP + TCP/443 (OpenRelay Metered)',
    iceServers: [
      { urls: 'stun:openrelay.metered.ca:80' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  }
];
