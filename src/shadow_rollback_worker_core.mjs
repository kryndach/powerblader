// Platform-Agnostic Universal Shadow Rollback Worker (Browser & Node)
import { createUniversalWorkerCore } from './universal_worker_core_factory.mjs';

const HIST_SIZE = 512;
const CHUNK_FRAMES = 4;
const MAX_BUF_POOL = 3;

export function createShadowWorkerController(postMsg, options = {}) {
  const coreFactory = options.coreFactory || createUniversalWorkerCore;
  const chunkFrames = options.chunkFrames || CHUNK_FRAMES;

  let core = null;
  let epoch = 0;
  let synced = false;
  let timelineStartFrame = 0;
  let confBuf = null;
  let confLen = 0;
  let confFrame = -1;
  let coreAtFrame = -1;
  let lastReportedConf = -1;
  let lastHashedFrame = -1;

  const p1Ring = new Uint32Array(HIST_SIZE);
  const p2Ring = new Uint32Array(HIST_SIZE);
  const inTag = new Int32Array(HIST_SIZE).fill(-1);
  const bufPool = [];
  let pooledReuses = 0;

  let latestConf = -1;
  let latestTarget = 0;
  let needCatchup = false;
  let pendingFlushId = null;
  let pendingOverclockMode = null;
  let job = null;
  let jobTimer = null;
  let yieldPending = false;

  const yieldCh = typeof MessageChannel === 'function'
    ? new MessageChannel() : null;
  if (yieldCh) {
    yieldCh.port1.onmessage = () => {
      if (!yieldPending) return;
      yieldPending = false;
      runJobChunk();
    };
  }

  function scheduleChunk() {
    if (yieldCh) {
      if (!yieldPending) {
        yieldPending = true;
        yieldCh.port2.postMessage(0);
      }
      return;
    }
    jobTimer = setTimeout(runJobChunk, 0);
  }

  function cancelJobTimer() {
    yieldPending = false;
    if (jobTimer !== null) {
      clearTimeout(jobTimer);
      jobTimer = null;
    }
  }

  function takeTransferBuffer(minLen) {
    for (let i = bufPool.length - 1; i >= 0; i--) {
      if (bufPool[i].byteLength >= minLen) {
        pooledReuses++;
        return bufPool.splice(i, 1)[0];
      }
    }
    return new ArrayBuffer(minLen);
  }

  function readStateView() {
    return typeof core.getMemfsStateView === 'function'
      ? core.getMemfsStateView() : core.saveStateBytes();
  }

  function storeCheckpoint(frame) {
    const view = readStateView();
    if (!confBuf || confBuf.length < view.length) {
      confBuf = new Uint8Array(view.length);
    }
    confBuf.set(view);
    confLen = view.length;
    confFrame = frame;
  }

  function maybeRecordHash(frame, hashesOut) {
    if (
      frame > timelineStartFrame &&
      frame % 30 === 0 &&
      frame > lastHashedFrame
    ) {
      hashesOut.push([frame, core.computeHash() >>> 0]);
      lastHashedFrame = frame;
    }
  }

  function advanceConfirmed(hashesOut, simP1 = null, simP2 = null) {
    const safeLimit = Math.min(latestConf + 1, latestTarget);
    if (confFrame >= safeLimit || inTag[confFrame % HIST_SIZE] !== confFrame) {
      return;
    }
    if (coreAtFrame !== confFrame) {
      core.loadStateBytes(confBuf.subarray(0, confLen));
      coreAtFrame = confFrame;
    }
    while (
      confFrame < safeLimit && inTag[confFrame % HIST_SIZE] === confFrame
    ) {
      maybeRecordHash(confFrame, hashesOut);
      const idx = confFrame % HIST_SIZE;
      const m1 = p1Ring[idx], m2 = p2Ring[idx];
      core.stepFrame(m1, m2, true);
      if (simP1) { simP1.push(m1); simP2.push(m2); }
      confFrame++;
      coreAtFrame = confFrame;
    }
    maybeRecordHash(confFrame, hashesOut);
    storeCheckpoint(confFrame);
  }

  function maybeReplyFlush() {
    if (pendingFlushId !== null && !job && !needCatchup) {
      const id = pendingFlushId;
      pendingFlushId = null;
      postMsg({ type: 'flushed', id, epoch, confirmedFrame: confFrame });
    }
  }

  function finishJob() {
    const cur = job;
    job = null;
    const view = readStateView();
    const outBuf = takeTransferBuffer(view.length);
    new Uint8Array(outBuf, 0, view.length).set(view);
    const simP1 = Uint32Array.from(cur.simP1);
    const simP2 = Uint32Array.from(cur.simP2);
    lastReportedConf = Math.max(lastReportedConf, cur.usedConfFrame);
    postMsg({
      type: 'catchup_state', epoch: cur.epoch, frame: cur.cursor,
      fromFrame: cur.fromFrame, usedConfFrame: cur.usedConfFrame,
      simP1, simP2, stateBuf: outBuf, stateLen: view.length,
      hashes: cur.hashes, pooledReuses
    }, [outBuf, simP1.buffer, simP2.buffer]);
    if (needCatchup) startOrPumpWork();
    else maybeReplyFlush();
  }

  function hasSpeculativeMismatch(cur) {
    for (let f = cur.usedConfFrame; f < cur.cursor; f++) {
      const idx = f % HIST_SIZE;
      const off = f - cur.fromFrame;
      if (
        inTag[idx] === f &&
        (p1Ring[idx] !== cur.simP1[off] || p2Ring[idx] !== cur.simP2[off])
      ) {
        return true;
      }
    }
    return false;
  }

  function runJobChunk() {
    jobTimer = null;
    if (!job || job.epoch !== epoch || !core || !synced) return;
    if (hasSpeculativeMismatch(job)) {
      if (job.hashes.length > 0) {
        postMsg({
          type: 'confirmed_progress', epoch,
          confirmedFrame: confFrame, hashes: job.hashes
        });
      }
      job = null;
      needCatchup = true;
      return startOrPumpWork();
    }
    let stepped = 0;
    while (
      stepped < chunkFrames &&
      job.cursor < latestTarget &&
      inTag[job.cursor % HIST_SIZE] === job.cursor
    ) {
      const idx = job.cursor % HIST_SIZE;
      const m1 = p1Ring[idx], m2 = p2Ring[idx];
      core.stepFrame(m1, m2, true);
      job.simP1.push(m1);
      job.simP2.push(m2);
      job.cursor++;
      coreAtFrame = job.cursor;
      stepped++;
    }
    if (
      job.cursor < latestTarget &&
      inTag[job.cursor % HIST_SIZE] === job.cursor
    ) {
      scheduleChunk();
      return;
    }
    finishJob();
  }

  function startOrPumpWork() {
    if (!core || !synced || job) return;
    const hashes = [];
    if (!needCatchup) {
      advanceConfirmed(hashes);
      if (hashes.length > 0 || confFrame > lastReportedConf) {
        lastReportedConf = Math.max(lastReportedConf, confFrame);
        postMsg({
          type: 'confirmed_progress', epoch, confirmedFrame: confFrame, hashes
        });
      }
      return maybeReplyFlush();
    }
    needCatchup = false;
    const fromFrame = confFrame;
    const simP1 = [], simP2 = [];
    advanceConfirmed(hashes, simP1, simP2);
    if (coreAtFrame !== confFrame) {
      core.loadStateBytes(confBuf.subarray(0, confLen));
      coreAtFrame = confFrame;
    }
    job = {
      epoch, fromFrame, usedConfFrame: confFrame, cursor: confFrame,
      simP1, simP2, hashes
    };
    runJobChunk();
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') {
      try {
        core = await coreFactory({
          systemId: msg.systemId || 'arcade',
          romBytes: msg.romBytes, romName: msg.romName,
          wasmModuleOverride: msg.wasmModule,
          wasmBinaryOverride: msg.wasmBinary,
          overclockMode: pendingOverclockMode ?? (msg.overclockMode || 0)
        });
        postMsg({ type: 'worker_booted' });
      } catch (err) {
        postMsg({ type: 'worker_error', error: err?.message || String(err) });
      }
      return;
    }
    if (msg.type === 'recycle_buf') {
      if (msg.buf instanceof ArrayBuffer && bufPool.length < MAX_BUF_POOL) {
        bufPool.push(msg.buf);
      }
      return;
    }
    if (msg.type === 'set_overclock') {
      pendingOverclockMode = Number(msg.mode) || 0;
      core?.setOverclockMode?.(pendingOverclockMode);
      return;
    }
    if (msg.type === 'destroy') {
      cancelJobTimer();
      try { yieldCh?.port1?.close?.(); yieldCh?.port2?.close?.(); } catch {}
      core?.destroy?.();
      job = null; core = null; synced = false; bufPool.length = 0;
      return;
    }
    if (!core) return;
    if (msg.type === 'sync_state') {
      cancelJobTimer(); job = null;
      epoch = msg.epoch;
      timelineStartFrame = msg.timelineStartFrame || 0;
      const bytes = new Uint8Array(msg.stateBuf, 0, msg.stateLen);
      core.loadStateBytes(bytes);
      coreAtFrame = msg.frame;
      storeCheckpoint(msg.frame);
      lastReportedConf = msg.frame;
      lastHashedFrame = -1;
      latestConf = msg.frame - 1;
      latestTarget = msg.frame;
      needCatchup = false;
      inTag.fill(-1);
      synced = true;
      postMsg({ type: 'synced', epoch, frame: msg.frame });
      return;
    }
    if (!synced || msg.epoch !== epoch) return;
    if (msg.type === 'inputs') {
      const start = msg.sliceStart;
      const p1 = msg.p1Masks, p2 = msg.p2Masks;
      for (let i = 0; i < p1.length; i++) {
        const f = start + i, idx = f % HIST_SIZE;
        p1Ring[idx] = p1[i] >>> 0;
        p2Ring[idx] = p2[i] >>> 0;
        inTag[idx] = f;
      }
      if (msg.confirmedFrame > latestConf) latestConf = msg.confirmedFrame;
      if (msg.targetFrame > latestTarget) latestTarget = msg.targetFrame;
      if (msg.needCatchup && !job) needCatchup = true;
      startOrPumpWork();
      return;
    }
    if (msg.type === 'flush') {
      pendingFlushId = msg.id;
      startOrPumpWork();
      maybeReplyFlush();
    }
  }

  return { handleMessage };
}
