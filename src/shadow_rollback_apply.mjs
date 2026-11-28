// Pure Helpers for Shadow Rollback Snapshot Selection & Catch-Up Application
import {
  encodeNesStateBytes, decodeNesStateBytes
} from './universal_worker_core_factory.mjs';
import {
  createFastSnapshotSlot, saveFastState, loadFastState
} from './fast_savestate.mjs';

export const MAX_APPLY_GAP = 3;
export const FALLBACK_APPLY_GAP = 8;
export const MAX_SLICE_LEN = 200;

function readCoreStateBytes(core) {
  if (typeof core.saveStateBytes === 'function') return core.saveStateBytes();
  if (core.cpu && core.ppu) return encodeNesStateBytes(core);
  if (core.rawCore?.saveStateBytes) return core.rawCore.saveStateBytes();
  if (core.rawCore?.cpu && core.rawCore?.ppu) {
    return encodeNesStateBytes(core.rawCore);
  }
  return null;
}

function writeCoreStateBytes(core, bytes) {
  const raw = core.rawCore || core;
  if (typeof raw.loadStateBytes === 'function') {
    raw.loadStateBytes(bytes);
    return;
  }
  if (raw.cpu && raw.ppu) decodeNesStateBytes(raw, bytes);
}

export function findEarliestMisprediction(engine, fromFrame) {
  const start = Math.max(engine.timelineStartFrame, fromFrame);
  const H = engine.historySize;
  for (let f = start; f < engine.currentFrame; f++) {
    const idx = f % H;
    if (
      engine.simulatedFrameTag[idx] === f &&
      (engine.getPlayerInput(1, f) !== engine.p1Simulated[idx] ||
        engine.getPlayerInput(2, f) !== engine.p2Simulated[idx])
    ) {
      return f;
    }
  }
  return null;
}

export function resolveSnapshotForSync(engine, core) {
  const cur = engine.currentFrame;
  if (
    cur === engine.timelineStartFrame ||
    engine.lastConfirmedRemoteFrame >= cur - 1
  ) {
    const bytes = readCoreStateBytes(core);
    return bytes ? { frame: cur, bytes } : null;
  }
  let f = Math.max(
    engine.timelineStartFrame,
    Math.min(engine.lastConfirmedRemoteFrame + 1, cur)
  );
  const B = engine.saveBufferSize;
  while (f > engine.timelineStartFrame && engine.saveRing[f % B]?.frame !== f) {
    f--;
  }
  const slot = engine.saveRing[f % B];
  if (!slot || slot.frame !== f) return null;
  if (slot.stateBytes) {
    const len = slot.usedLen || slot.stateBytes.length;
    const bytes = new Uint8Array(len);
    bytes.set(slot.stateBytes.subarray(0, len));
    return { frame: f, bytes };
  }
  const raw = core?.rawCore || core;
  if (slot.cpuMem && raw?.cpu && raw?.ppu) {
    const tmp = createFastSnapshotSlot();
    saveFastState(raw, tmp, cur);
    try {
      loadFastState(raw, slot);
      const bytes = encodeNesStateBytes(raw);
      return bytes ? { frame: f, bytes } : null;
    } finally {
      loadFastState(raw, tmp);
    }
  }
  return null;
}

export function applyShadowHashes(engine, hashes) {
  if (!engine || !hashes?.length) return;
  for (const [f, h] of hashes) engine.localHashes.set(f, h >>> 0);
  engine._cleanupOldHashes();
  engine._verifyConfirmedHashes();
}

export function buildWorkerInputSlice(
  engine, workerConfirmedFrame, allowEmpty = false
) {
  const end = engine.currentFrame;
  const rawStart = Math.max(
    engine.timelineStartFrame, Math.min(workerConfirmedFrame, end)
  );
  const start = Math.max(rawStart, end - MAX_SLICE_LEN);
  const len = Math.max(0, end - start);
  if (len === 0 && !allowEmpty) return null;
  const p1Masks = new Uint32Array(len);
  const p2Masks = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const f = start + i;
    p1Masks[i] = engine.getPlayerInput(1, f);
    p2Masks[i] = engine.getPlayerInput(2, f);
  }
  return { start, end, p1Masks, p2Masks };
}

export function applyShadowCatchupState(
  engine, msg, stats, staleDropStreak, confirmedWatermark = msg.usedConfFrame
) {
  const gap = engine.currentFrame - msg.frame;
  const limit = staleDropStreak >= 2 ? FALLBACK_APPLY_GAP : MAX_APPLY_GAP;
  if (gap < 0 || gap > limit) {
    stats.shadowDroppedStale++;
    return { applied: false, gap };
  }
  const baseF = engine.earliestMispredictedFrame ?? msg.fromFrame;
  const depth = Math.max(1, engine.currentFrame - baseF);
  const curFb = engine.core.getFrameBuffer();
  if (engine.enableVisualSmoothing && depth >= 4 && curFb) {
    if (!engine._preRollbackBuffer ||
        engine._preRollbackBuffer.length !== curFb.length) {
      engine._preRollbackBuffer = new Uint32Array(curFb.length);
    }
    engine._preRollbackBuffer.set(curFb);
    engine.lastRollbackBlendAlpha = depth >= 6 ? 0.25 : 0.18;
  }
  engine._rollbackDeclickL = engine._lastEmittedAudioL || 0;
  engine._rollbackDeclickR = engine._lastEmittedAudioR || 0;
  engine._rollbackDeclickSamples = 48;
  writeCoreStateBytes(
    engine.core, new Uint8Array(msg.stateBuf, 0, msg.stateLen)
  );

  const H = engine.historySize;
  for (let i = 0; i < msg.simP1.length; i++) {
    const f = msg.fromFrame + i;
    if (f >= engine.currentFrame - H) {
      const idx = f % H;
      engine.p1Simulated[idx] = msg.simP1[i];
      engine.p2Simulated[idx] = msg.simP2[i];
      engine.simulatedFrameTag[idx] = f;
    }
  }
  if (gap > 0) {
    engine.suppressCallbacks = true;
    for (let f = msg.frame; f < engine.currentFrame; f++) {
      const m1 = engine.getPlayerInput(1, f);
      const m2 = engine.getPlayerInput(2, f);
      const idx = f % H;
      engine.p1Simulated[idx] = m1;
      engine.p2Simulated[idx] = m2;
      engine.simulatedFrameTag[idx] = f;
      engine.core.stepFrame(m1, m2, true);
    }
    engine.suppressCallbacks = false;
  }
  engine.rollbacksTotal++;
  engine.rollbacksThisSec++;
  engine.lastRollbackDepth = depth;
  if (depth > engine.maxRollbackDepthSeen) {
    engine.maxRollbackDepthSeen = depth;
  }
  stats.shadowSwaps++;
  stats.totalGap += gap;
  if (gap > stats.maxGap) stats.maxGap = gap;
  engine.earliestMispredictedFrame = findEarliestMisprediction(
    engine, msg.fromFrame
  );
  const msgConf = Number.isFinite(msg.usedConfFrame) ? msg.usedConfFrame : -1;
  const wmConf = Number.isFinite(confirmedWatermark) ? confirmedWatermark : -1;
  const keepUpTo = Math.max(msgConf, wmConf);
  for (const k of engine.localHashes.keys()) {
    if (k > keepUpTo) engine.localHashes.delete(k);
  }
  engine._verifyConfirmedHashes();
  return { applied: true, gap };
}
