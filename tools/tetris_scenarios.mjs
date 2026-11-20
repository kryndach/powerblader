// Deterministic Human-Timed Tetris Moves, Button-Spam & Bad-Net Profiles
import fs from 'fs';
import path from 'path';
import { INPUT_BITS } from '../src/netplay_engine.mjs';

const L = INPUT_BITS.LEFT;
const R = INPUT_BITS.RIGHT;
const U = INPUT_BITS.UP;
const D = INPUT_BITS.DOWN;
const A = INPUT_BITS.A;
const B = INPUT_BITS.B;

export function resolveSaveSlotPath(
  rootDir, crcHex, slot = 1, fallbackCrcs = []
) {
  const envPath = process.env.TETRIS_SAVE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const roots = [rootDir];
  const gitFile = path.join(rootDir, '.git');
  try {
    if (fs.existsSync(gitFile) && fs.statSync(gitFile).isFile()) {
      const m = /gitdir:\s*(.+)/i.exec(fs.readFileSync(gitFile, 'utf8'));
      if (m) {
        const gd = path.resolve(rootDir, m[1].trim());
        roots.push(path.resolve(gd, '..', '..', '..'));
      }
    }
  } catch {}
  for (const crc of [crcHex, ...fallbackCrcs]) {
    if (!crc) continue;
    const rel = path.join('local', 'saves', `${crc}_slot_${slot}.json`);
    for (const r of roots) {
      const full = path.join(r, rel);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function expandSegments(segments, totalFrames) {
  const out = new Uint16Array(totalFrames);
  let f = 0;
  let idx = 0;
  while (f < totalFrames) {
    const [mask, dur] = segments[idx % segments.length];
    idx++;
    for (let k = 0; k < dur && f < totalFrames; k++) out[f++] = mask;
  }
  return out;
}

// Human-timed multi-piece Tetris plays (~60fps: 4-5f taps, 5-8f pauses, drops)
export function buildHumanTetrisScripts(totalFrames = 360) {
  const p1Segs = [
    [0, 6], [L, 5], [0, 6], [L, 5], [0, 5], [A, 4], [0, 6], [A, 4], [0, 5],
    [U, 4], [D, 16], [0, 18],
    [R, 5], [0, 6], [R, 5], [0, 5], [B, 4], [0, 5], [U, 4], [D, 16], [0, 18],
    [L, 14], [0, 4], [A, 4], [0, 5], [B, 4], [0, 4], [D, 18], [0, 18],
    [R, 5], [0, 5], [A, 4], [0, 5], [A, 4], [0, 4], [U, 4], [D, 16], [0, 18]
  ];
  const p2Segs = [
    [0, 11], [R, 5], [0, 6], [B, 4], [0, 6], [B, 4], [0, 5],
    [U, 4], [D, 16], [0, 18],
    [L, 5], [0, 6], [L, 5], [0, 5], [A, 4], [0, 5], [U, 4], [D, 16], [0, 18],
    [R, 12], [0, 5], [B, 4], [0, 5], [A, 4], [0, 4], [D, 18], [0, 18],
    [L, 5], [0, 5], [B, 4], [0, 5], [U, 4], [D, 16], [0, 18]
  ];
  return {
    p1: expandSegments(p1Segs, totalFrames),
    p2: expandSegments(p2Segs, totalFrames)
  };
}

// Rapid 20-30Hz button-mashing stress test for both players simultaneously
export function buildButtonSpamScripts(totalFrames = 300) {
  const p1 = new Uint16Array(totalFrames);
  const p2 = new Uint16Array(totalFrames);
  const p1Cycle = [L, A, R, B, L | A, D, R | B, U, A, L, B, R];
  const p2Cycle = [R, B, L, A, R | B, U, L | A, D, B, R, A, L];
  for (let f = 0; f < totalFrames; f++) {
    p1[f] = f % 2 === 0 ? p1Cycle[(f >> 1) % p1Cycle.length] : 0;
    p2[f] = f % 3 !== 0 ? p2Cycle[f % p2Cycle.length] : 0;
  }
  return { p1, p2 };
}

export const TETRIS_NETWORK_PROFILES = [
  {
    id: 'good_sgr_5f',
    label: 'Good SG-RU Pinggy (210ms +/-12ms, 5f)',
    rttMs: 210, jitterMs: 12, lossPct: 0, clumpEveryMs: 0, clumpHoldMs: 0,
    delay: 5, mode: 'human', frames: 360,
    maxP95Ms: 24, maxFreezes: 0, maxUnderruns: 0
  },
  {
    id: 'clump_sgr_0f',
    label: 'Pinggy Clump 0f-Delay (240ms +/-25ms + 120ms clump, 0f)',
    rttMs: 240, jitterMs: 25, lossPct: 0, clumpEveryMs: 1200, clumpHoldMs: 120,
    delay: 0, mode: 'human', frames: 360,
    maxP95Ms: 58, maxFreezes: 18, maxUnderruns: 0
  },
  {
    id: 'bad_net_5f',
    label: 'Bad Internet (300ms +/-55ms, 3% loss + 200ms clump, 5f)',
    rttMs: 300, jitterMs: 55, lossPct: 3, clumpEveryMs: 1100, clumpHoldMs: 200,
    delay: 5, mode: 'human', frames: 360,
    maxP95Ms: 48, maxFreezes: 10, maxUnderruns: 0
  },
  {
    id: 'extreme_bad_0f',
    label: 'Extreme Bad Net 0f (280ms +/-45ms, 2% loss + 180ms clump, 0f)',
    rttMs: 280, jitterMs: 45, lossPct: 2, clumpEveryMs: 1200, clumpHoldMs: 180,
    delay: 0, mode: 'human', frames: 360,
    maxP95Ms: 64, maxFreezes: 26, maxUnderruns: 0
  },
  {
    id: 'spam_240_5f',
    label: 'Rapid Button-Spam @ 240ms + Clump (5f)',
    rttMs: 240, jitterMs: 25, lossPct: 1, clumpEveryMs: 1200, clumpHoldMs: 120,
    delay: 5, mode: 'spam', frames: 300,
    maxP95Ms: 38, maxFreezes: 3, maxUnderruns: 0
  },
  {
    id: 'spam_240_0f',
    label: 'Rapid Button-Spam @ 240ms + Clump (0f)',
    rttMs: 240, jitterMs: 25, lossPct: 1, clumpEveryMs: 1200, clumpHoldMs: 120,
    delay: 0, mode: 'spam', frames: 300,
    maxP95Ms: 60, maxFreezes: 16, maxUnderruns: 0
  }
];

export function countRegionPixelDiff(fbA, fbB, width, x0, x1, y0, y1) {
  if (!fbA || !fbB) return 0;
  let diff = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      if ((fbA[row + x] & 0xffffff) !== (fbB[row + x] & 0xffffff)) diff++;
    }
  }
  return diff;
}
