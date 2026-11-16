// Universal Deterministic Rollback Netplay Engine (NES, Sega, Multi-Console)
import {
  INPUT_BITS, crc32Bytes, computeRomCrc32, formatHex32, computeDeterministicHash
} from './crc32.mjs';
import { patchJsnes8x16Sprites } from './jsnes_ppu_patches.mjs';
import {
  saveFastState, loadFastState, applyControllerMask
} from './fast_savestate.mjs';
import {
  SEGA_MD_INPUT_BITS, N3DS_INPUT_BITS, CONSOLE_PROFILES,
  SUPPORTED_ROM_EXTENSIONS, detectSystemFromRomName, detectSystemFromRomBytes,
  isSupportedRomFile, NesCoreAdapter, GenericCoreAdapter, ensureCoreAdapter
} from './core_adapter.mjs';
import {
  resetEngineTimeline, wrapNesNetplayCallbacks, processRemoteInputPacket,
  buildNetplayInputPacket, buildNetplayTelemetry
} from './netplay_packets.mjs';

export {
  INPUT_BITS, SEGA_MD_INPUT_BITS, N3DS_INPUT_BITS, CONSOLE_PROFILES,
  SUPPORTED_ROM_EXTENSIONS, detectSystemFromRomName, detectSystemFromRomBytes,
  isSupportedRomFile, NesCoreAdapter, GenericCoreAdapter, ensureCoreAdapter,
  crc32Bytes, computeRomCrc32, formatHex32, computeDeterministicHash,
  patchJsnes8x16Sprites, saveFastState, loadFastState, applyControllerMask
};

export class RollbackNetplayEngine {
  constructor(coreOrNes, options = {}) {
    this.core = ensureCoreAdapter(coreOrNes);
    this.nes = this.core.rawCore;
    this.systemId = this.core.systemId;
    this.localPlayer = options.localPlayer || 1;
    this.online = Boolean(options.online);
    this.inputDelayFrames = options.inputDelayFrames ?? 2;
    this.maxRollbackFrames = options.maxRollbackFrames ?? 25;
    this.enableRiftPacing = Boolean(options.enableRiftPacing);
    this.enableVisualSmoothing =
      options.enableVisualSmoothing ?? (this.systemId !== 'arcade');
    this.historySize = 256;
    this.saveBufferSize =
      options.saveBufferSize ?? (this.systemId === 'arcade' ? 36 : 64);
    this.sessionId = options.sessionId || 'default';
    this.syncPaused = false;
    this._pixelCount = this.core.pixelCount || 256 * 240;
    this._preRollbackBuffer = new Uint32Array(this._pixelCount);
    this._smoothedDisplayBuffer = new Uint32Array(this._pixelCount);
    this.lastRollbackBlendAlpha = 0;
    this.suppressCallbacks = false;
    wrapNesNetplayCallbacks(this, this.nes);
    this.saveRing = new Array(this.saveBufferSize);
    for (let i = 0; i < this.saveBufferSize; i++) {
      this.saveRing[i] = this.core.createSnapshotSlot();
    }
    this.resetTimeline(0);
  }

  resetTimeline(startFrame = 0, newSessionId = null) {
    resetEngineTimeline(this, startFrame, newSessionId);
  }
  static computeRecommendedInputDelay(
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
  setInputDelay(frames) {
    const nextDelay = Math.max(0, Math.min(8, Math.floor(frames)));
    if (nextDelay === this.inputDelayFrames) return;
    const targetNew = this.currentFrame + nextDelay - 1;
    const lastSched = Math.max(
      this.timelineStartFrame, this.lastLocalScheduledFrame
    );
    const prevMask = this.getLocalInputAt(lastSched);
    while (this.lastLocalScheduledFrame < targetNew) {
      this.lastLocalScheduledFrame++;
      this._setPlayerInput(
        this.localPlayer, this.lastLocalScheduledFrame, prevMask, true
      );
    }
    this.inputDelayFrames = nextDelay;
  }
  _setPlayerInput(playerNum, frame, mask, confirmed) {
    const idx = frame % this.historySize;
    const val = mask >>> 0;
    if (playerNum === 1) {
      this.p1Inputs[idx] = val;
      if (confirmed) this.p1Confirmed[idx] = frame;
    } else {
      this.p2Inputs[idx] = val;
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
      if (frame <= this.lastConfirmedRemoteFrame &&
          frame <= this.currentFrame &&
          this.localHashes.has(frame) && frame > this.lastVerifiedFrame) {
        const localHash = this.localHashes.get(frame);
        this.lastVerifiedFrame = frame;
        this.lastLocalHash = localHash;
        this.lastRemoteHash = remoteHash;
        this.syncStatus = localHash === remoteHash ? 'SYNC_OK' : 'DESYNC';
        if (localHash !== remoteHash) this.desyncCount++;
      }
    }
  }

  _executeRollbackIfNeeded() {
    const minRb = Math.max(
      this.timelineStartFrame, this.currentFrame - (this.saveBufferSize - 4)
    );
    let rbFrame =
      this.earliestMispredictedFrame !== null &&
      this.earliestMispredictedFrame < this.currentFrame
        ? Math.max(minRb, this.earliestMispredictedFrame) : null;
    this.earliestMispredictedFrame = null;

    for (let f = minRb; f < this.currentFrame; f++) {
      if (rbFrame !== null && f >= rbFrame) break;
      const idx = f % this.historySize;
      if (this.simulatedFrameTag[idx] === f &&
          (this.getPlayerInput(1, f) !== this.p1Simulated[idx] ||
           this.getPlayerInput(2, f) !== this.p2Simulated[idx])) {
        rbFrame = f;
        break;
      }
    }
    if (rbFrame === null || rbFrame >= this.currentFrame) return;
    while (rbFrame > minRb &&
           this.saveRing[rbFrame % this.saveBufferSize]?.frame !== rbFrame) {
      rbFrame--;
    }
    const slot = this.saveRing[rbFrame % this.saveBufferSize];
    if (!slot || slot.frame !== rbFrame) return;

    const depth = this.currentFrame - rbFrame;
    this.rollbacksTotal++;
    this.rollbacksThisSec++;
    this.lastRollbackDepth = depth;
    if (depth > this.maxRollbackDepthSeen) this.maxRollbackDepthSeen = depth;
    const curFb = this.core.getFrameBuffer();
    if (this.enableVisualSmoothing && depth >= 4 && curFb) {
      this._preRollbackBuffer.set(curFb);
      this.lastRollbackBlendAlpha = depth >= 6 ? 0.25 : 0.18;
    }
    this._rollbackDeclickL = this._lastEmittedAudioL || 0;
    this._rollbackDeclickR = this._lastEmittedAudioR || 0;
    this._rollbackDeclickSamples = 48;

    this.core.loadState(slot);
    for (const k of this.localHashes.keys()) {
      if (k > rbFrame) this.localHashes.delete(k);
    }
    this.suppressCallbacks = true;
    for (let f = rbFrame; f < this.currentFrame; f++) {
      if (f > rbFrame && f >= this.lastConfirmedRemoteFrame) {
        this.core.saveState(this.saveRing[f % this.saveBufferSize], f);
      }
      const m1 = this.getPlayerInput(1, f);
      const m2 = this.getPlayerInput(2, f);
      const idx = f % this.historySize;
      this.p1Simulated[idx] = m1;
      this.p2Simulated[idx] = m2;
      this.simulatedFrameTag[idx] = f;
      this.core.stepFrame(m1, m2, true);
      if ((f + 1) % 30 === 0) {
        this.localHashes.set(f + 1, this.core.computeHash());
      }
    }
    this.suppressCallbacks = false;
  }

  stepNetplayFrame(localButtonsMask, p2LocalButtonsMask = 0, options = null) {
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
      const m1 = localButtonsMask >>> 0, m2 = p2LocalButtonsMask >>> 0;
      this._setPlayerInput(1, f, m1, true);
      this._setPlayerInput(2, f, m2, true);
      this.p1Simulated[idx] = m1;
      this.p2Simulated[idx] = m2;
      this.simulatedFrameTag[idx] = f;
      this.lastConfirmedRemoteFrame = f;
      this.lastLocalScheduledFrame = f;
      if (this.systemId === 'nes') {
        this.core.saveState(this.saveRing[f % this.saveBufferSize], f);
      }
      this.suppressCallbacks = false;
      this.core.stepFrame(m1, m2, false);
      this.currentFrame++;
      this.lastStepMs = performance.now() - t0;
      return {
        stepped: true, stalled: false, packetToSend: null,
        p1Mask: m1, p2Mask: m2
      };
    }

    if (!options?.skipRollback) this._executeRollbackIfNeeded();
    const turbo = Math.max(1, options?.turboSpeed || 1);
    const maxAhead = turbo > 1
      ? this.saveBufferSize - 6
      : Math.min(this.saveBufferSize - 6, this.maxRollbackFrames);
    const prevF = Math.max(this.timelineStartFrame, this.currentFrame - 1);
    if (this.currentFrame - this.lastConfirmedRemoteFrame > maxAhead) {
      this.stallFrames++;
      this._verifyConfirmedHashes();
      const packetToSend = options?.skipPacket
        ? null : this._buildInputPacket(this.lastLocalScheduledFrame);
      this.lastStepMs = performance.now() - t0;
      return {
        stepped: false, stalled: true, packetToSend,
        p1Mask: this.getPlayerInput(1, prevF),
        p2Mask: this.getPlayerInput(2, prevF)
      };
    }
    const clumpPad = Math.min(4.5, (this.rxClumpFrames || 0) * 1.25);
    if (this.enableRiftPacing && this.riftFrames > (1.75 + clumpPad) * turbo) {
      const cooldownTarget = this.riftFrames > 5 * turbo ? 4 : 10;
      if (this._riftCooldown >= cooldownTarget) {
        this._riftCooldown = 0;
        this.riftWaitFrames++;
        this._verifyConfirmedHashes();
        const pkt = options?.skipPacket
          ? null : this._buildInputPacket(this.lastLocalScheduledFrame);
        this.lastStepMs = performance.now() - t0;
        return {
          stepped: false, stalled: false, riftPaced: true, packetToSend: pkt,
          p1Mask: this.getPlayerInput(1, prevF),
          p2Mask: this.getPlayerInput(2, prevF)
        };
      }
      this._riftCooldown++;
    } else this._riftCooldown = 0;

    const targetInputFrame = this.currentFrame + this.inputDelayFrames;
    while (this.lastLocalScheduledFrame < targetInputFrame) {
      this.lastLocalScheduledFrame++;
      this._setPlayerInput(
        this.localPlayer, this.lastLocalScheduledFrame, localButtonsMask, true
      );
    }
    const f = this.currentFrame, idx = f % this.historySize;
    this.core.saveState(this.saveRing[f % this.saveBufferSize], f);
    const p1Mask = this.getPlayerInput(1, f);
    const p2Mask = this.getPlayerInput(2, f);
    this.p1Simulated[idx] = p1Mask;
    this.p2Simulated[idx] = p2Mask;
    this.simulatedFrameTag[idx] = f;
    this.suppressCallbacks = false;
    this.core.stepFrame(p1Mask, p2Mask, Boolean(options?.skipPacket));
    this.currentFrame++;
    if (this.currentFrame % 30 === 0) {
      this.localHashes.set(this.currentFrame, this.core.computeHash());
      this._cleanupOldHashes();
    }
    this._verifyConfirmedHashes();
    const packetToSend = options?.skipPacket
      ? null : this._buildInputPacket(this.lastLocalScheduledFrame);
    this.lastStepMs = performance.now() - t0;
    return { stepped: true, stalled: false, packetToSend, p1Mask, p2Mask };
  }
  exportSyncState() {
    return this.core.exportSyncState(
      this.sessionId, this.currentFrame, this.inputDelayFrames
    );
  }
  importSyncState(syncObj, options = {}) {
    if (!this.core.importSyncState(syncObj)) return false;
    if (!options?.preserveLocalInputDelay &&
        typeof syncObj.inputDelayFrames === 'number') {
      this.inputDelayFrames = syncObj.inputDelayFrames;
    }
    if (syncObj.sessionId) this.sessionId = syncObj.sessionId;
    this.resetTimeline(syncObj.frame || 0);
    return true;
  }
  getTelemetry() { return buildNetplayTelemetry(this); }
}
export { RollbackNetplayEngine as NesNetplayEngine };
