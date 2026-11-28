// Universal Host Controller for Off-Thread Shadow Rollback (All 4 Consoles)
import {
  findEarliestMisprediction, resolveSnapshotForSync, applyShadowHashes,
  buildWorkerInputSlice, applyShadowCatchupState
} from './shadow_rollback_apply.mjs';

const WASM_SHADOW_SYSTEMS = new Set([
  'arcade', 'snes', 'sega_md', 'sega_sms'
]);

export function shouldAttachShadowWorker(systemId) {
  return WASM_SHADOW_SYSTEMS.has(systemId);
}

async function createPlatformTransport(onMessage, onError) {
  const sendWith = (w) => (m, x) =>
    (x?.length ? w.postMessage(m, x) : w.postMessage(m));
  if (!globalThis.process?.versions?.node) {
    const wUrl = new URL('../js/fbneo_shadow_worker.mjs', import.meta.url);
    const w = new Worker(wUrl, { type: 'module' });
    w.onmessage = (ev) => onMessage(ev.data);
    w.onerror = (err) => onError(err);
    return { postMessage: sendWith(w), terminate: () => w.terminate() };
  }
  const { Worker: NodeWorker } = await import('node:worker_threads');
  const url = new URL('./node_fbneo_shadow_worker.mjs', import.meta.url);
  const w = new NodeWorker(url);
  w.on('message', onMessage);
  w.on('error', onError);
  return { postMessage: sendWith(w), terminate: () => w.terminate() };
}

export function createShadowRollbackHost(core, options = {}) {
  const systemId = options.systemId || core?.systemId ||
    (core?.cpu && core?.ppu ? 'nes' : 'arcade');
  let transport = null;
  let workerBooted = false;
  let failed = false;
  let destroyed = false;
  let epoch = 0;
  let syncedEpoch = -1;
  let syncSentEpoch = -1;
  let workerConfirmedFrame = 0;
  let lastSentTargetFrame = -1;
  let lastSentConfirmedFrame = -1;
  let catchupInFlight = false;
  let pendingCatchup = null;
  let staleDropStreak = 0;
  let attachedEngine = null;
  let flushSeq = 0;
  const syncWaiters = [];
  const flushWaiters = new Map();
  const stats = {
    shadowSwaps: 0, shadowDroppedStale: 0, maxGap: 0, totalGap: 0,
    pooledReuses: 0
  };

  function post(msg, xfer = null) {
    if (!destroyed && !failed && transport) transport.postMessage(msg, xfer);
  }

  function recycleBuffer(buf) {
    if (buf instanceof ArrayBuffer && buf.byteLength > 0) {
      try { post({ type: 'recycle_buf', buf }, [buf]); } catch {}
    }
  }

  function resolveWaiters(list, val) {
    while (list.length > 0) list.shift()(val);
  }

  function sendInputsToWorker(engine, needCatchup) {
    const slice = buildWorkerInputSlice(engine, workerConfirmedFrame);
    if (!slice) return false;
    const { start, end, p1Masks, p2Masks } = slice;
    post({
      type: 'inputs', epoch, sliceStart: start, targetFrame: end,
      confirmedFrame: engine.lastConfirmedRemoteFrame,
      p1Masks, p2Masks, needCatchup
    }, [p1Masks.buffer, p2Masks.buffer]);
    lastSentTargetFrame = end;
    lastSentConfirmedFrame = engine.lastConfirmedRemoteFrame;
    if (needCatchup) catchupInFlight = true;
    return true;
  }

  function trySyncFromEngine(engine) {
    if (destroyed || failed || !workerBooted || !engine) return;
    if (syncSentEpoch === epoch) return;
    if (
      engine.currentFrame > engine.timelineStartFrame &&
      engine.earliestMispredictedFrame !== null
    ) {
      return;
    }
    const snap = resolveSnapshotForSync(engine, core);
    if (!snap) return;
    syncSentEpoch = epoch;
    workerConfirmedFrame = snap.frame;
    lastSentTargetFrame = snap.frame;
    lastSentConfirmedFrame = snap.frame - 1;
    catchupInFlight = false;
    if (pendingCatchup?.stateBuf) recycleBuffer(pendingCatchup.stateBuf);
    pendingCatchup = null;
    staleDropStreak = 0;
    post({
      type: 'sync_state', epoch,
      timelineStartFrame: engine.timelineStartFrame,
      frame: snap.frame, stateBuf: snap.bytes.buffer,
      stateLen: snap.bytes.byteLength
    }, [snap.bytes.buffer]);
    if (engine.currentFrame > snap.frame) sendInputsToWorker(engine, false);
  }

  function handleWorkerMessage(msg) {
    if (destroyed || !msg || typeof msg !== 'object') return;
    if (msg.type === 'worker_booted') {
      workerBooted = true;
      if (attachedEngine) trySyncFromEngine(attachedEngine);
      return;
    }
    if (msg.type === 'worker_error') {
      failed = true;
      resolveWaiters(syncWaiters, false);
      for (const fn of flushWaiters.values()) fn(false);
      flushWaiters.clear();
      return;
    }
    if (msg.type === 'flushed') {
      const fn = flushWaiters.get(msg.id);
      if (fn) { flushWaiters.delete(msg.id); fn(true); }
      return;
    }
    if (msg.epoch !== epoch) {
      if (msg.stateBuf) recycleBuffer(msg.stateBuf);
      return;
    }
    if (msg.type === 'synced') {
      syncedEpoch = epoch;
      workerConfirmedFrame = msg.frame;
      resolveWaiters(syncWaiters, true);
      return;
    }
    if (msg.type === 'confirmed_progress') {
      workerConfirmedFrame = Math.max(workerConfirmedFrame, msg.confirmedFrame);
      applyShadowHashes(attachedEngine, msg.hashes);
      return;
    }
    if (msg.type === 'catchup_state') {
      catchupInFlight = false;
      workerConfirmedFrame = Math.max(workerConfirmedFrame, msg.usedConfFrame);
      if (typeof msg.pooledReuses === 'number') {
        stats.pooledReuses = msg.pooledReuses;
      }
      applyShadowHashes(attachedEngine, msg.hashes);
      if (pendingCatchup?.stateBuf) recycleBuffer(pendingCatchup.stateBuf);
      pendingCatchup = msg;
    }
  }

  function handleWorkerError() {
    failed = true;
    resolveWaiters(syncWaiters, false);
  }

  function isReady(engine = attachedEngine) {
    return (
      !destroyed && !failed && workerBooted &&
      epoch > 0 && syncedEpoch === epoch && Boolean(engine)
    );
  }

  const startInit = (tr) => {
    if (destroyed) { tr.terminate?.(); return; }
    transport = tr;
    const romBytes = core.getRomBytes?.() ||
      core._lastRomBinary || core._romBinaryString || null;
    post({
      type: 'init',
      systemId,
      wasmModule: core.getWasmModule?.() || null,
      wasmBinary: core.getWasmBinary?.() || null,
      romBytes,
      romName: core.getRomName?.() || (systemId === 'nes' ? 'game.nes' : 'rom'),
      overclockMode: core._overclockMode || core.ppu?._overclockMode || 0
    });
  };
  if (options.transport) {
    options.transport.onMessage(handleWorkerMessage);
    options.transport.onError?.(handleWorkerError);
    startInit(options.transport);
  } else {
    createPlatformTransport(handleWorkerMessage, handleWorkerError)
      .then(startInit).catch(handleWorkerError);
  }

  return {
    attachEngine(engine) {
      attachedEngine = engine;
      epoch++;
      syncedEpoch = -1;
      syncSentEpoch = -1;
      trySyncFromEngine(engine);
    },
    isReady,
    trySyncFromEngine,
    setOverclockMode(mode) {
      post({ type: 'set_overclock', mode: Number(mode) || 0 });
    },
    onTimelineReset(engine) {
      attachedEngine = engine;
      epoch++;
      syncedEpoch = -1;
      syncSentEpoch = -1;
      catchupInFlight = false;
      if (pendingCatchup?.stateBuf) recycleBuffer(pendingCatchup.stateBuf);
      pendingCatchup = null;
      staleDropStreak = 0;
      trySyncFromEngine(engine);
    },
    onRemoteInputsUpdated(engine) {
      if (!isReady(engine)) return;
      const confJumped =
        engine.lastConfirmedRemoteFrame >= lastSentConfirmedFrame + 4;
      if (engine.earliestMispredictedFrame !== null) {
        sendInputsToWorker(engine, !catchupInFlight);
      } else if (confJumped) {
        sendInputsToWorker(engine, false);
      }
    },
    applyPendingAndRequestCatchup(engine) {
      if (!isReady(engine)) return;
      if (pendingCatchup && pendingCatchup.epoch === epoch) {
        const msg = pendingCatchup;
        pendingCatchup = null;
        const res = applyShadowCatchupState(
          engine, msg, stats, staleDropStreak, workerConfirmedFrame
        );
        recycleBuffer(msg.stateBuf);
        staleDropStreak = res.applied ? 0 : staleDropStreak + 1;
      }
      const mis = engine.earliestMispredictedFrame ??
        findEarliestMisprediction(engine, workerConfirmedFrame);
      if (mis !== null) {
        engine.earliestMispredictedFrame = mis;
        if (!catchupInFlight) sendInputsToWorker(engine, true);
      }
    },
    notifyFrameStepped(engine) {
      if (!isReady(engine)) return;
      if (
        catchupInFlight ||
        engine.lastConfirmedRemoteFrame >= lastSentConfirmedFrame + 4 ||
        engine.currentFrame - lastSentTargetFrame >= 6
      ) {
        sendInputsToWorker(engine, false);
      }
    },
    waitUntilSynced(timeoutMs = 15000) {
      if (isReady()) return Promise.resolve(true);
      if (failed || destroyed) return Promise.resolve(false);
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        syncWaiters.push((ok) => { clearTimeout(t); resolve(ok); });
      });
    },
    flush(engine = attachedEngine, timeoutMs = 5000) {
      if (!isReady(engine)) return Promise.resolve(false);
      if (engine) {
        const hasMis = engine.earliestMispredictedFrame !== null ||
          findEarliestMisprediction(engine, workerConfirmedFrame) !== null;
        sendInputsToWorker(engine, hasMis && !catchupInFlight);
      }
      const id = ++flushSeq;
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          flushWaiters.delete(id);
          resolve(false);
        }, timeoutMs);
        flushWaiters.set(id, (ok) => { clearTimeout(t); resolve(ok); });
        post({ type: 'flush', id, epoch });
      });
    },
    getStats() {
      return {
        systemId, ready: isReady(), failed, catchupInFlight,
        workerConfirmedFrame,
        shadowSwaps: stats.shadowSwaps,
        shadowDroppedStale: stats.shadowDroppedStale,
        pooledReuses: stats.pooledReuses,
        maxGap: stats.maxGap,
        avgGap: stats.shadowSwaps > 0
          ? Number((stats.totalGap / stats.shadowSwaps).toFixed(2)) : 0
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try { transport?.postMessage({ type: 'destroy' }); } catch {}
      try { transport?.terminate?.(); } catch {}
      transport = null;
      attachedEngine = null;
      pendingCatchup = null;
      resolveWaiters(syncWaiters, false);
      for (const fn of flushWaiters.values()) fn(false);
      flushWaiters.clear();
    }
  };
}
