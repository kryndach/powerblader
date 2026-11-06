// Universal Deterministic NES Netplay Engine (GGPO Rollback + Input Delay)
import {
  INPUT_BITS, crc32Bytes, computeRomCrc32,
  formatHex32, computeDeterministicHash
} from './crc32.mjs';
import { patchJsnes8x16Sprites } from './jsnes_ppu_patches.mjs';
import {
  createFastSnapshotSlot, saveFastState, loadFastState,
  applyControllerMask, serializeCompactNesState, restoreCompactNesState
} from './fast_savestate.mjs';
import {
  resetEngineTimeline, wrapNesNetplayCallbacks, processRemoteInputPacket,
  buildNetplayInputPacket, buildNetplayTelemetry
} from './netplay_packets.mjs';

export {
  INPUT_BITS, crc32Bytes, computeRomCrc32, formatHex32,
  computeDeterministicHash, patchJsnes8x16Sprites,
  saveFastState, loadFastState, applyControllerMask
};

export class NesNetplayEngine {
  constructor(nes, options = {}) {
    this.nes = nes;
    patchJsnes8x16Sprites(this.nes);
    this.localPlayer = options.localPlayer || 1;
    this.online = Boolean(options.online);
    this.inputDelayFrames = options.inputDelayFrames ?? 2;
    this.maxRollbackFrames = options.maxRollbackFrames ?? 20;
    this.enableRiftPacing = Boolean(options.enableRiftPacing);
    this.enableVisualSmoothing = options.enableVisualSmoothing !== false;
    this.historySize = 256;
    this.saveBufferSize = options.saveBufferSize ?? 64;
    this.sessionId = options.sessionId || 'default';
    this.syncPaused = false;
    this._preRollbackBuffer = new Uint32Array(256 * 240);
    this._smoothedDisplayBuffer = new Uint32Array(256 * 240);
    this.lastRollbackBlendAlpha = 0;
    this.suppressCallbacks = false;
    wrapNesNetplayCallbacks(this, this.nes);
    this.saveRing = new Array(this.saveBufferSize);
    for (let i = 0; i < this.saveBufferSize; i++) {
      this.saveRing[i] = createFastSnapshotSlot();
    }
    this.resetTimeline(0);
  }

  resetTimeline(startFrame = 0, newSessionId = null) {
    resetEngineTimeline(this, startFrame, newSessionId);
  }

  static computeRecommendedInputDelay(rttMs, jitterMs = 0, rxClumpFrames = 0) {
    if (!Number.isFinite(rttMs) || rttMs <= 0) return 2;
    const clumpMs = Math.min(25, Math.max(0, (rxClumpFrames || 0) - 1) * 5);
    const effRtt = rttMs + Math.min(35, Math.max(0, jitterMs) * 0.5) + clumpMs;
    if (effRtt <= 85) return 2;
    if (effRtt <= 165) return 3;
    if (effRtt <= 295) return 4;
    return 5;
  }

  setInputDelay(frames) {
    const nextDelay = Math.max(0, Math.min(8, Math.floor(frames)));
    if (nextDelay === this.inputDelayFrames) return;
    const targetNew = this.currentFrame + nextDelay - 1;
    const lastSched = Math.max(
      this.timelineStartFrame,
      this.lastLocalScheduledFrame
    );
    const prevMask = this.getLocalInputAt(lastSched);
    while (this.lastLocalScheduledFrame < targetNew) {
      this.lastLocalScheduledFrame++;
      this._setPlayerInput(
        this.localPlayer,
        this.lastLocalScheduledFrame,
        prevMask,
        true
      );
    }
    this.inputDelayFrames = nextDelay;
  }

  _setPlayerInput(playerNum, frame, mask, confirmed) {
    const idx = frame % this.historySize;
    if (playerNum === 1) {
      this.p1Inputs[idx] = mask & 0xff;
      if (confirmed) this.p1Confirmed[idx] = frame;
    } else {
      this.p2Inputs[idx] = mask & 0xff;
      if (confirmed) this.p2Confirmed[idx] = frame;
    }
  }

  getPlayerInput(playerNum, frame) {
    if (frame < 0) return 0;
    const idx = frame % this.historySize;
    const remIdx = this.lastConfirmedRemoteFrame % this.historySize;
    const hasRem = this.lastConfirmedRemoteFrame >= this.timelineStartFrame;
    if (playerNum === 1) {
      if (this.p1Confirmed[idx] === frame) return this.p1Inputs[idx];
      if (hasRem && this.localPlayer === 2) return this.p1Inputs[remIdx];
      return 0;
    }
    if (this.p2Confirmed[idx] === frame) return this.p2Inputs[idx];
    if (hasRem && this.localPlayer === 1) return this.p2Inputs[remIdx];
    return 0;
  }

  getLocalInputAt(frame) {
    return this.getPlayerInput(this.localPlayer, frame);
  }

  receiveRemoteInputPacket(packet, nowMs = performance.now()) {
    processRemoteInputPacket(this, packet, nowMs);
  }

  _buildInputPacket(latestScheduledFrame) {
    return buildNetplayInputPacket(this, latestScheduledFrame);
  }

  _cleanupOldHashes() {
    while (this.localHashes.size > 40) {
      this.localHashes.delete(this.localHashes.keys().next().value);
    }
    while (this.remoteHashes.size > 40) {
      this.remoteHashes.delete(this.remoteHashes.keys().next().value);
    }
  }

  _verifyConfirmedHashes() {
    if (this.earliestMispredictedFrame !== null) return;
    for (const [frame, remoteHash] of this.remoteHashes.entries()) {
      if (
        frame <= this.lastConfirmedRemoteFrame &&
        frame <= this.currentFrame &&
        this.localHashes.has(frame) &&
        frame > this.lastVerifiedFrame
      ) {
        const localHash = this.localHashes.get(frame);
        this.lastVerifiedFrame = frame;
        this.lastLocalHash = localHash;
        this.lastRemoteHash = remoteHash;
        if (localHash === remoteHash) this.syncStatus = 'SYNC_OK';
        else {
          this.syncStatus = 'DESYNC';
          this.desyncCount++;
        }
      }
    }
  }

  _executeRollbackIfNeeded() {
    const minRb = Math.max(
      this.timelineStartFrame,
      this.currentFrame - (this.saveBufferSize - 4)
    );
    let rbFrame =
      this.earliestMispredictedFrame !== null &&
      this.earliestMispredictedFrame < this.currentFrame
        ? Math.max(minRb, this.earliestMispredictedFrame)
        : null;
    this.earliestMispredictedFrame = null;

    for (let f = minRb; f < this.currentFrame; f++) {
      if (rbFrame !== null && f >= rbFrame) break;
      const idx = f % this.historySize;
      if (this.simulatedFrameTag[idx] === f) {
        const want1 = this.getPlayerInput(1, f);
        const want2 = this.getPlayerInput(2, f);
        if (want1 !== this.p1Simulated[idx] ||
            want2 !== this.p2Simulated[idx]) {
          rbFrame = f;
          break;
        }
      }
    }

    if (rbFrame === null || rbFrame >= this.currentFrame) return;
    const slot = this.saveRing[rbFrame % this.saveBufferSize];
    if (!slot || slot.frame !== rbFrame) return;

    const depth = this.currentFrame - rbFrame;
    this.rollbacksTotal++;
    this.rollbacksThisSec++;
    this.lastRollbackDepth = depth;
    if (depth > this.maxRollbackDepthSeen) this.maxRollbackDepthSeen = depth;
    if (this.enableVisualSmoothing && depth >= 4 && this.nes.ppu?.buffer) {
      this._preRollbackBuffer.set(this.nes.ppu.buffer);
      this.lastRollbackBlendAlpha = depth >= 6 ? 0.25 : 0.18;
    }
    this._rollbackDeclickL = this._lastEmittedAudioL || 0;
    this._rollbackDeclickR = this._lastEmittedAudioR || 0;
    this._rollbackDeclickSamples = 48;

    loadFastState(this.nes, slot);
    this.suppressCallbacks = true;
    this.nes.ppu._headlessFrame = true;
    for (let f = rbFrame; f < this.currentFrame; f++) {
      if (f > rbFrame) {
        saveFastState(this.nes, this.saveRing[f % this.saveBufferSize], f);
      }
      const m1 = this.getPlayerInput(1, f);
      const m2 = this.getPlayerInput(2, f);
      const idx = f % this.historySize;
      this.p1Simulated[idx] = m1;
      this.p2Simulated[idx] = m2;
      this.simulatedFrameTag[idx] = f;
      applyControllerMask(this.nes, 1, m1);
      applyControllerMask(this.nes, 2, m2);
      this.nes.frame();
      if ((f + 1) % 30 === 0) {
        this.localHashes.set(f + 1, computeDeterministicHash(this.nes));
      }
    }
    this.nes.ppu._headlessFrame = false;
    this.suppressCallbacks = false;
  }

  stepNetplayFrame(localButtonsMask, p2LocalButtonsMask = 0) {
    const t0 = performance.now();
    const now = Date.now();
    if (now - this.lastRollbackSecTick >= 1000) {
      this.rollbacksPerSec = this.rollbacksThisSec;
      this.rollbacksThisSec = 0;
      this.lastRollbackSecTick = now;
    }

    if (this.syncPaused) {
      return {
        stepped: false, stalled: true, syncPaused: true,
        packetToSend: null, p1Mask: 0, p2Mask: 0
      };
    }

    if (!this.online) {
      const f = this.currentFrame;
      const idx = f % this.historySize;
      this._setPlayerInput(1, f, localButtonsMask, true);
      this._setPlayerInput(2, f, p2LocalButtonsMask, true);
      this.p1Simulated[idx] = localButtonsMask & 0xff;
      this.p2Simulated[idx] = p2LocalButtonsMask & 0xff;
      this.simulatedFrameTag[idx] = f;
      this.lastConfirmedRemoteFrame = f;
      this.lastLocalScheduledFrame = f;
      saveFastState(this.nes, this.saveRing[f % this.saveBufferSize], f);
      applyControllerMask(this.nes, 1, localButtonsMask);
      applyControllerMask(this.nes, 2, p2LocalButtonsMask);
      this.suppressCallbacks = false;
      this.nes.frame();
      this.currentFrame++;
      this.lastStepMs = performance.now() - t0;
      return {
        stepped: true, stalled: false, packetToSend: null,
        p1Mask: localButtonsMask, p2Mask: p2LocalButtonsMask
      };
    }

    this._executeRollbackIfNeeded();

    const prevF = Math.max(this.timelineStartFrame, this.currentFrame - 1);
    const framesAhead = this.currentFrame - this.lastConfirmedRemoteFrame;
    if (framesAhead > this.maxRollbackFrames) {
      this.stallFrames++;
      this._verifyConfirmedHashes();
      const packetToSend = this._buildInputPacket(this.lastLocalScheduledFrame);
      this.lastStepMs = performance.now() - t0;
      return {
        stepped: false, stalled: true, packetToSend,
        p1Mask: this.getPlayerInput(1, prevF),
        p2Mask: this.getPlayerInput(2, prevF)
      };
    }

    if (this.enableRiftPacing && this.riftFrames > 1.75) {
      const cooldownTarget = this.riftFrames > 5 ? 4 : 10;
      if (this._riftCooldown >= cooldownTarget) {
        this._riftCooldown = 0;
        this.riftWaitFrames++;
        this._verifyConfirmedHashes();
        const pkt = this._buildInputPacket(this.lastLocalScheduledFrame);
        this.lastStepMs = performance.now() - t0;
        return {
          stepped: false, stalled: false, riftPaced: true, packetToSend: pkt,
          p1Mask: this.getPlayerInput(1, prevF),
          p2Mask: this.getPlayerInput(2, prevF)
        };
      }
      this._riftCooldown++;
    } else {
      this._riftCooldown = 0;
    }

    const targetInputFrame = this.currentFrame + this.inputDelayFrames;
    while (this.lastLocalScheduledFrame < targetInputFrame) {
      this.lastLocalScheduledFrame++;
      this._setPlayerInput(
        this.localPlayer, this.lastLocalScheduledFrame, localButtonsMask, true
      );
    }

    const f = this.currentFrame;
    const idx = f % this.historySize;
    saveFastState(this.nes, this.saveRing[f % this.saveBufferSize], f);

    const p1Mask = this.getPlayerInput(1, f);
    const p2Mask = this.getPlayerInput(2, f);
    this.p1Simulated[idx] = p1Mask;
    this.p2Simulated[idx] = p2Mask;
    this.simulatedFrameTag[idx] = f;
    applyControllerMask(this.nes, 1, p1Mask);
    applyControllerMask(this.nes, 2, p2Mask);
    this.suppressCallbacks = false;
    this.nes.frame();
    this.currentFrame++;

    if (this.currentFrame % 30 === 0) {
      const h = computeDeterministicHash(this.nes);
      this.localHashes.set(this.currentFrame, h);
      this._cleanupOldHashes();
    }
    this._verifyConfirmedHashes();

    const packetToSend = this._buildInputPacket(this.lastLocalScheduledFrame);
    this.lastStepMs = performance.now() - t0;

    return { stepped: true, stalled: false, packetToSend, p1Mask, p2Mask };
  }

  exportSyncState() {
    return serializeCompactNesState(
      this.nes, this.sessionId, this.currentFrame, this.inputDelayFrames
    );
  }

  importSyncState(syncObj, options = {}) {
    if (!restoreCompactNesState(this.nes, syncObj)) return false;
    if (!options?.preserveLocalInputDelay &&
        typeof syncObj.inputDelayFrames === 'number') {
      this.inputDelayFrames = syncObj.inputDelayFrames;
    }
    if (syncObj.sessionId) this.sessionId = syncObj.sessionId;
    this.resetTimeline(syncObj.frame || 0);
    return true;
  }

  getTelemetry() {
    return buildNetplayTelemetry(this);
  }
}
