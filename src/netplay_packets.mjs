// Netplay Packet Serialization, Callback Wrapping & Timeline Helpers
import { formatHex32 } from './crc32.mjs';
import { matchesBinarySessionId } from './binary_net_codec.mjs';

export function resetEngineTimeline(
  engine,
  startFrame = 0,
  newSessionId = null
) {
  if (newSessionId) engine.sessionId = newSessionId;
  engine.timelineStartFrame = startFrame;
  engine.currentFrame = startFrame;
  engine.p1Inputs = new Uint32Array(engine.historySize);
  engine.p2Inputs = new Uint32Array(engine.historySize);
  engine.p1Confirmed = new Int32Array(engine.historySize).fill(-1);
  engine.p2Confirmed = new Int32Array(engine.historySize).fill(-1);
  engine.p1Simulated = new Uint32Array(engine.historySize);
  engine.p2Simulated = new Uint32Array(engine.historySize);
  engine.simulatedFrameTag = new Int32Array(engine.historySize).fill(-1);

  engine.lastConfirmedRemoteFrame = startFrame - 1;
  engine.peerAckedLocalFrame = startFrame - 1;
  engine._lastSentHashFrame = -1;
  engine._lastSentHashRepeats = 0;
  engine.lastLocalScheduledFrame = startFrame - 1;
  engine.earliestMispredictedFrame = null;

  for (let f = startFrame; f < startFrame + engine.inputDelayFrames; f++) {
    engine._setPlayerInput(engine.localPlayer, f, 0, true);
  }
  if (engine.inputDelayFrames > 0) {
    engine.lastLocalScheduledFrame = startFrame + engine.inputDelayFrames - 1;
  }

  engine.localHashes = new Map();
  engine.remoteHashes = new Map();
  engine.syncStatus = 'SYNC_OK';
  engine.lastVerifiedFrame = -1;
  engine.lastLocalHash = 0;
  engine.lastRemoteHash = 0;
  engine.desyncCount = 0;
  engine.rollbacksTotal = 0;
  engine.rollbacksThisSec = 0;
  engine.rollbacksPerSec = 0;
  engine.lastRollbackSecTick = Date.now();
  engine.lastRollbackDepth = 0;
  engine.maxRollbackDepthSeen = 0;
  engine._lastRollbackAtFrame = startFrame - 10;
  engine.stallFrames = 0;
  engine.riftFrames = 0;
  engine.riftWaitFrames = 0;
  engine._riftCooldown = 0;
  engine.lastStepMs = 0;
  engine._lastRxAtMs = 0;
  engine._rxGapSamples = [];
  engine.rxGapP95Ms = 0;
  engine.rxClumpFrames = 0;
  engine.peerClumpFrames = 0;
  engine.clumpBiasFrames = 0;
  engine.remoteInputDelayFrames = 0;
  engine.lastRollbackBlendAlpha = 0;
  engine.smoothedFramesCount = 0;
  engine._lastEmittedAudioL = 0;
  engine._lastEmittedAudioR = 0;
  engine._rollbackDeclickL = 0;
  engine._rollbackDeclickR = 0;
  engine._rollbackDeclickSamples = 0;

  for (let i = 0; i < engine.saveBufferSize; i++) {
    engine.core.resetSnapshotSlot(engine.saveRing[i]);
  }
  const initSlot = engine.saveRing[startFrame % engine.saveBufferSize];
  engine.core.onTimelineReset(initSlot, startFrame);
}

export function wrapNesNetplayCallbacks(engine, rawCore) {
  const target = rawCore || engine.core;
  if (!target || !target.opts || target._netplayWrapped) return;
  target._netplayWrapped = true;
  const origFrame = (target.ui && target.ui.writeFrame) || target.opts.onFrame;
  const origAudio = target.opts.onAudioSample;

  const wrappedFrame = (fb) => {
    if (engine.suppressCallbacks || !origFrame) return;
    if (
      engine.enableVisualSmoothing &&
      engine.lastRollbackBlendAlpha > 0 &&
      fb
    ) {
      const wOld = Math.round(engine.lastRollbackBlendAlpha * 256);
      const wNew = 256 - wOld;
      const prev = engine._preRollbackBuffer;
      const out = engine._smoothedDisplayBuffer;
      const count = engine._pixelCount || out.length;
      for (let i = 0; i < count; i++) {
        const cNew = fb[i] >>> 0;
        const cOld = prev[i] >>> 0;
        if (cNew === cOld) {
          out[i] = cNew;
        } else {
          const r = (((cNew & 0xff) * wNew + (cOld & 0xff) * wOld) >> 8) & 0xff;
          const g =
            ((((cNew >> 8) & 0xff) * wNew + ((cOld >> 8) & 0xff) * wOld) >>
              8) &
            0xff;
          const b =
            ((((cNew >> 16) & 0xff) * wNew + ((cOld >> 16) & 0xff) * wOld) >>
              8) &
            0xff;
          out[i] = (cNew & 0xff000000) | (b << 16) | (g << 8) | r;
        }
      }
      engine.lastRollbackBlendAlpha = 0;
      engine.smoothedFramesCount = (engine.smoothedFramesCount || 0) + 1;
      origFrame(out);
      return;
    }
    origFrame(fb);
  };
  target.opts.onFrame = wrappedFrame;
  if (target.ui) target.ui.writeFrame = wrappedFrame;

  target.opts.onAudioSample = (l, r) => {
    if (engine.suppressCallbacks || !origAudio) return;
    let outL = l;
    let outR = r;
    if (engine._rollbackDeclickSamples > 0) {
      const alpha = engine._rollbackDeclickSamples / 48;
      outL = l * (1 - alpha) + engine._rollbackDeclickL * alpha;
      outR = r * (1 - alpha) + engine._rollbackDeclickR * alpha;
      engine._rollbackDeclickSamples--;
    }
    engine._lastEmittedAudioL = outL;
    engine._lastEmittedAudioR = outR;
    origAudio(outL, outR);
  };
}

export function processRemoteInputPacket(
  engine,
  packet,
  nowMs = performance.now()
) {
  if (
    !packet ||
    typeof packet.startFrame !== 'number' ||
    !Array.isArray(packet.inputs)
  ) {
    return;
  }
  if (!matchesBinarySessionId(packet.sessionId, engine.sessionId)) {
    return;
  }
  const remotePlayer = engine.localPlayer === 1 ? 2 : 1;
  const confirmedArr =
    remotePlayer === 1 ? engine.p1Confirmed : engine.p2Confirmed;
  const inputsArr = remotePlayer === 1 ? engine.p1Inputs : engine.p2Inputs;
  const simulatedArr =
    remotePlayer === 1 ? engine.p1Simulated : engine.p2Simulated;
  const minValidFrame = Math.max(
    engine.timelineStartFrame,
    engine.currentFrame - (engine.saveBufferSize - 4)
  );

  const rawLen = packet.inputs.length;
  if (rawLen === 0) return;
  const totalLen = Math.max(rawLen, packet.tailCount || 0);
  const tailVal = packet.inputs[rawLen - 1] >>> 0;
  let newlyConfirmedCount = 0;
  for (let i = totalLen - 1; i >= 0; i--) {
    const f = packet.startFrame - i;
    if (f < minValidFrame) continue;
    const mask = i < rawLen ? packet.inputs[i] >>> 0 : tailVal;
    const idx = f % engine.historySize;
    if (confirmedArr[idx] !== f) {
      newlyConfirmedCount++;
      if (f < engine.currentFrame && engine.simulatedFrameTag[idx] === f) {
        if (simulatedArr[idx] !== mask) {
          if (
            engine.earliestMispredictedFrame === null ||
            f < engine.earliestMispredictedFrame
          ) {
            engine.earliestMispredictedFrame = f;
          }
        }
      }
      inputsArr[idx] = mask;
      confirmedArr[idx] = f;
      if (f > engine.lastConfirmedRemoteFrame) {
        engine.lastConfirmedRemoteFrame = f;
      }
    }
  }

  if (newlyConfirmedCount > 0) {
    let gapMs = 0;
    if (engine._lastRxAtMs > 0 && nowMs >= engine._lastRxAtMs) {
      gapMs = nowMs - engine._lastRxAtMs;
      engine._rxGapSamples.push(gapMs);
      if (engine._rxGapSamples.length > 20) engine._rxGapSamples.shift();
      const sorted = engine._rxGapSamples.slice().sort((a, b) => a - b);
      const p95Idx = Math.min(
        sorted.length - 1,
        Math.floor(sorted.length * 0.95)
      );
      engine.rxGapP95Ms = Number(sorted[p95Idx].toFixed(1));
    }
    engine._lastRxAtMs = nowMs;
    const gapClump = gapMs > 25 ? (gapMs - 20) / 16.667 : 0;
    const burstClump = Math.max(0, newlyConfirmedCount - 1, gapClump);
    engine.rxClumpFrames = Number(
      (engine.rxClumpFrames * 0.8 + Math.min(8, burstClump) * 0.2).toFixed(2)
    );
  }

  if (typeof packet.ack === 'number' && Number.isFinite(packet.ack)) {
    const prev = engine.peerAckedLocalFrame ?? (engine.timelineStartFrame - 1);
    if (packet.ack > prev) engine.peerAckedLocalFrame = Math.floor(packet.ack);
  }
  if (typeof packet.rxClump === 'number' && Number.isFinite(packet.rxClump)) {
    engine.peerClumpFrames = packet.rxClump;
  }
  if (
    typeof packet.inputDelay === 'number' &&
    Number.isFinite(packet.inputDelay)
  ) {
    engine.remoteInputDelayFrames = Math.max(
      0,
      Math.min(20, Math.floor(packet.inputDelay))
    );
  }

  if (typeof packet.peerLead === 'number' && Number.isFinite(packet.peerLead)) {
    const peerEmulConfirmed = Math.max(
      engine.timelineStartFrame,
      engine.lastConfirmedRemoteFrame - (engine.remoteInputDelayFrames || 0)
    );
    const myLead = engine.currentFrame - peerEmulConfirmed;
    const rawRift = (myLead - packet.peerLead) * 0.5;
    const clumpDiff = (engine.rxClumpFrames - engine.peerClumpFrames) * 0.35;
    engine.clumpBiasFrames = Number(
      Math.max(-1.5, Math.min(1.5, clumpDiff)).toFixed(2)
    );
    const sampleRift = rawRift - engine.clumpBiasFrames;
    engine.riftFrames = Number(
      (engine.riftFrames * 0.7 + sampleRift * 0.3).toFixed(2)
    );
  }

  if (
    typeof packet.hashFrame === 'number' &&
    typeof packet.hash === 'number' &&
    packet.hashFrame >= engine.timelineStartFrame
  ) {
    engine.remoteHashes.set(packet.hashFrame, packet.hash >>> 0);
    engine._cleanupOldHashes();
  }
}

export function buildNetplayInputPacket(engine, latestScheduledFrame) {
  const avail = Math.max(
    1, latestScheduledFrame - engine.timelineStartFrame + 1
  );
  const maxWin = Math.min(Math.max(32, engine.maxRollbackFrames || 32), avail);
  const acked = engine.peerAckedLocalFrame ?? (engine.timelineStartFrame - 1);
  const count = acked >= engine.timelineStartFrame
    ? Math.min(maxWin, Math.max(4, latestScheduledFrame - acked + 2))
    : maxWin;
  const fullInputs = new Array(count);
  for (let i = 0; i < count; i++) {
    fullInputs[i] = engine.getLocalInputAt(latestScheduledFrame - i);
  }
  const tailVal = fullInputs[count - 1];
  let trimLen = count;
  while (trimLen > 1 && fullInputs[trimLen - 2] === tailVal) trimLen--;
  const inputs = trimLen < count ? fullInputs.slice(0, trimLen) : fullInputs;
  const peerEmulConfirmed = Math.max(
    engine.timelineStartFrame,
    engine.lastConfirmedRemoteFrame - (engine.remoteInputDelayFrames || 0)
  );
  const pkt = {
    type: 'netplay_input', sessionId: engine.sessionId,
    player: engine.localPlayer, startFrame: latestScheduledFrame,
    ack: engine.lastConfirmedRemoteFrame,
    inputDelay: engine.inputDelayFrames,
    peerLead: engine.currentFrame - peerEmulConfirmed,
    rxClump: engine.rxClumpFrames, inputs
  };
  if (trimLen < count) pkt.tailCount = count;
  const canSendHash =
    engine.localHashes.size > 0 && engine.earliestMispredictedFrame === null;
  if (canSendHash) {
    let bestFrame = -1;
    for (const k of engine.localHashes.keys()) {
      if (k <= engine.lastConfirmedRemoteFrame &&
          k <= engine.currentFrame && k > bestFrame) {
        bestFrame = k;
      }
    }
    if (bestFrame >= 0) {
      if (bestFrame !== engine._lastSentHashFrame) {
        engine._lastSentHashFrame = bestFrame;
        engine._lastSentHashRepeats = 0;
      }
      if ((engine._lastSentHashRepeats || 0) < 2) {
        engine._lastSentHashRepeats = (engine._lastSentHashRepeats || 0) + 1;
        pkt.hashFrame = bestFrame;
        pkt.hash = engine.localHashes.get(bestFrame);
      }
    }
  }
  return pkt;
}

export function buildNetplayTelemetry(engine) {
  return {
    systemId: engine.core?.systemId || 'nes',
    currentFrame: engine.currentFrame,
    lastConfirmedRemoteFrame: engine.lastConfirmedRemoteFrame,
    frameAdvantage:
      engine.currentFrame - Math.max(0, engine.lastConfirmedRemoteFrame),
    riftFrames: engine.riftFrames,
    riftWaitFrames: engine.riftWaitFrames,
    clumpBiasFrames: engine.clumpBiasFrames,
    rxGapP95Ms: engine.rxGapP95Ms,
    rxClumpFrames: engine.rxClumpFrames,
    peerClumpFrames: engine.peerClumpFrames,
    smoothedFramesCount: engine.smoothedFramesCount || 0,
    inputDelayFrames: engine.inputDelayFrames,
    maxRollbackFrames: engine.maxRollbackFrames,
    rollbacksTotal: engine.rollbacksTotal,
    rollbacksPerSec: engine.rollbacksPerSec,
    lastRollbackDepth: engine.lastRollbackDepth,
    maxRollbackDepthSeen: engine.maxRollbackDepthSeen,
    stallFrames: engine.stallFrames,
    syncStatus: engine.syncStatus,
    lastVerifiedFrame: engine.lastVerifiedFrame,
    lastLocalHash: formatHex32(engine.lastLocalHash),
    lastRemoteHash: formatHex32(engine.lastRemoteHash),
    desyncCount: engine.desyncCount,
    lastStepMs: Number(engine.lastStepMs.toFixed(2))
  };
}
