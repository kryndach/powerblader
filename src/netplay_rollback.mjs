// Rollback Timeline Re-Simulation, Hash Verification & Auto-Delay Policy
export function computeRecommendedInputDelay(
  rttMs, jitterMs = 0, rxClumpFrames = 0, currentDelay = null
) {
  if (!Number.isFinite(rttMs) || rttMs <= 0) return 2;
  const clumpMs = Math.min(25, Math.max(0, (rxClumpFrames || 0) - 1) * 5);
  const eff = rttMs + Math.min(35, Math.max(0, jitterMs) * 0.5) + clumpMs;
  const base = eff <= 85 ? 2 : eff <= 165 ? 3 : eff <= 310 ? 4 : 5;
  if (!Number.isFinite(currentDelay) || base === currentDelay) return base;
  const b = [0, 0, 85, 165, 310, 9999];
  if (base > currentDelay && currentDelay >= 2 && currentDelay <= 4) {
    return eff > b[currentDelay] + 15 ? base : currentDelay;
  }
  if (base < currentDelay && currentDelay >= 3 && currentDelay <= 5) {
    return eff < b[currentDelay - 1] - 20 ? base : currentDelay;
  }
  return base;
}

export function cleanupOldHashes(engine) {
  while (engine.localHashes.size > 40) {
    engine.localHashes.delete(engine.localHashes.keys().next().value);
  }
  while (engine.remoteHashes.size > 40) {
    engine.remoteHashes.delete(engine.remoteHashes.keys().next().value);
  }
}

export function verifyConfirmedHashes(engine) {
  if (engine.earliestMispredictedFrame !== null) return;
  for (const [frame, remoteHash] of engine.remoteHashes.entries()) {
    if (
      frame <= engine.lastConfirmedRemoteFrame &&
      frame <= engine.currentFrame &&
      engine.localHashes.has(frame) &&
      frame > engine.lastVerifiedFrame
    ) {
      const localHash = engine.localHashes.get(frame);
      engine.lastVerifiedFrame = frame;
      engine.lastLocalHash = localHash;
      engine.lastRemoteHash = remoteHash;
      engine.syncStatus = localHash === remoteHash ? 'SYNC_OK' : 'DESYNC';
      if (localHash !== remoteHash) engine.desyncCount++;
    }
  }
}

function findRollbackStartFrame(engine, minRb) {
  let rbFrame =
    engine.earliestMispredictedFrame !== null &&
    engine.earliestMispredictedFrame < engine.currentFrame
      ? Math.max(minRb, engine.earliestMispredictedFrame)
      : null;
  engine.earliestMispredictedFrame = null;

  for (let f = minRb; f < engine.currentFrame; f++) {
    if (rbFrame !== null && f >= rbFrame) break;
    const idx = f % engine.historySize;
    if (
      engine.simulatedFrameTag[idx] === f &&
      (engine.getPlayerInput(1, f) !== engine.p1Simulated[idx] ||
        engine.getPlayerInput(2, f) !== engine.p2Simulated[idx])
    ) {
      rbFrame = f;
      break;
    }
  }
  if (rbFrame === null || rbFrame >= engine.currentFrame) return null;
  while (
    rbFrame > minRb &&
    engine.saveRing[rbFrame % engine.saveBufferSize]?.frame !== rbFrame
  ) {
    rbFrame--;
  }
  const slot = engine.saveRing[rbFrame % engine.saveBufferSize];
  return slot && slot.frame === rbFrame ? rbFrame : null;
}

export function executeRollbackIfNeeded(engine) {
  const minRb = Math.max(
    engine.timelineStartFrame,
    engine.currentFrame - (engine.saveBufferSize - 4)
  );
  const rbFrame = findRollbackStartFrame(engine, minRb);
  if (rbFrame === null) return;

  const depth = engine.currentFrame - rbFrame;
  const isHeavy = engine.systemId === 'arcade';
  if (
    isHeavy &&
    depth < engine.saveBufferSize - 8 &&
    engine.currentFrame - (engine._lastRollbackAtFrame ?? -99) < 3
  ) {
    engine.earliestMispredictedFrame = rbFrame;
    return;
  }

  const slot = engine.saveRing[rbFrame % engine.saveBufferSize];
  engine._lastRollbackAtFrame = engine.currentFrame;
  engine.rollbacksTotal++;
  engine.rollbacksThisSec++;
  engine.lastRollbackDepth = depth;
  if (depth > engine.maxRollbackDepthSeen) engine.maxRollbackDepthSeen = depth;

  const curFb = engine.core.getFrameBuffer();
  if (engine.enableVisualSmoothing && depth >= 4 && curFb) {
    engine._preRollbackBuffer.set(curFb);
    engine.lastRollbackBlendAlpha = depth >= 6 ? 0.25 : 0.18;
  }
  engine._rollbackDeclickL = engine._lastEmittedAudioL || 0;
  engine._rollbackDeclickR = engine._lastEmittedAudioR || 0;
  engine._rollbackDeclickSamples = 48;

  engine.core.loadState(slot);
  for (const k of engine.localHashes.keys()) {
    if (k > rbFrame) engine.localHashes.delete(k);
  }
  engine.suppressCallbacks = true;
  for (let f = rbFrame; f < engine.currentFrame; f++) {
    if (f > rbFrame) {
      const needHash = isHeavy && f % 30 === 0;
      const shouldSave = isHeavy
        ? needHash || f === engine.lastConfirmedRemoteFrame + 1
        : f >= engine.lastConfirmedRemoteFrame;
      if (shouldSave) {
        engine.core.saveState(engine.saveRing[f % engine.saveBufferSize], f);
        if (needHash) engine.localHashes.set(f, engine.core.computeHash());
      } else {
        engine.saveRing[f % engine.saveBufferSize].frame = -1;
      }
    }
    const m1 = engine.getPlayerInput(1, f);
    const m2 = engine.getPlayerInput(2, f);
    const idx = f % engine.historySize;
    engine.p1Simulated[idx] = m1;
    engine.p2Simulated[idx] = m2;
    engine.simulatedFrameTag[idx] = f;
    engine.core.stepFrame(m1, m2, true);
    if (!isHeavy && (f + 1) % 30 === 0) {
      engine.localHashes.set(f + 1, engine.core.computeHash());
    }
  }
  engine.suppressCallbacks = false;
}
