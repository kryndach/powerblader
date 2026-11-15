// Full-Stack HTTP Striped Transfer, FBNeo WASM & Live Rollback Benchmark
import { crc32Hex } from '/src/crc32.mjs';
import { fetchStripedBinary, uploadStripedRom } from './rom_fast_transfer.mjs';
import {
  createFbneoArcadeCore, createMinimalArcadeTestZip
} from '/src/fbneo_arcade_core.mjs';
import {
  NesNetplayEngine, INPUT_BITS, formatHex32
} from '/src/netplay_engine.mjs';

function makePseudoRandomBytes(kb, seed = 0x13579bdf) {
  const u8 = new Uint8Array(kb * 1024);
  let x = seed >>> 0;
  for (let i = 0; i < u8.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    u8[i] = x & 0xff;
  }
  return u8;
}

function scriptedMask(playerIdx, frame) {
  if (playerIdx === 1) {
    return (frame % 14 < 7 ? INPUT_BITS.LEFT : INPUT_BITS.RIGHT) |
      (frame % 9 === 0 ? INPUT_BITS.A : 0);
  }
  return (frame % 16 < 8 ? INPUT_BITS.RIGHT : INPUT_BITS.LEFT) |
    (frame % 11 === 0 ? INPUT_BITS.B : 0);
}

export function buildNetplayRecommendations(reportState, pc1ToPc2) {
  const openRtc = (reportState.webrtcProfiles || []).find((p) => p.open);
  const wssRtt = reportState.wssRttMs ?? 120;
  const useP2p = Boolean(openRtc && openRtc.rttMs && openRtc.rttMs < wssRtt);
  const bestRtt = useP2p ? openRtc.rttMs : wssRtt;
  const clump = (pc1ToPc2?.clumpPct ?? 0) > 35
    ? 3 : (pc1ToPc2?.clumpPct ?? 0) > 15 ? 2 : 1;
  const nesDelayFrames = NesNetplayEngine.computeRecommendedInputDelay(
    bestRtt, reportState.wssJitterMs || 0, clump
  );
  const arcadeDelayFrames = Math.min(
    5, Math.max(nesDelayFrames, bestRtt >= 160 ? 5 : 4)
  );
  const wb = reportState.wasmBench;
  const cpu60FpsOk = Boolean(
    wb?.pc1?.rb5Ms < 16.7 && wb?.pc2?.rb5Ms < 16.7
  );
  const transport = useP2p
    ? `WebRTC P2P (${openRtc.selectedPair || 'UDP'})`
    : reportState.dualWsOk
      ? 'Dual-WSS Relay (ws + wsAux)' : 'Single-WSS Relay';
  return { transport, nesDelayFrames, arcadeDelayFrames, cpu60FpsOk };
}

export function createAutotestNetplayAndHttpManager(ctx) {
  let cachedCore = null;
  let liveEngine = null;
  let lastRxDedup = '';
  const waiters = new Map();

  function waitMsg(key, timeoutMs = 35000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { waiters.delete(key); resolve(null); },
        timeoutMs);
      waiters.set(key, (val) => { clearTimeout(t); resolve(val); });
    });
  }

  function resolveWaiter(key, val) {
    const fn = waiters.get(key);
    if (fn) { waiters.delete(key); fn(val); }
  }

  async function measureLocalWasmAndCpu() {
    const tBoot = performance.now();
    if (!cachedCore) {
      cachedCore = await createFbneoArcadeCore({
        romBytes: createMinimalArcadeTestZip(), romName: 'minivadr.zip'
      });
    }
    const bootMs = Math.max(1, Math.round(performance.now() - tBoot));
    cachedCore.loadROM();
    for (let f = 0; f < 60; f++) {
      cachedCore.stepFrame(scriptedMask(1, f), scriptedMask(2, f), true);
    }
    const hash60 = formatHex32(cachedCore.computeHash());
    const slot = { frame: -1, stateBytes: null };
    const tVis = performance.now();
    for (let i = 0; i < 16; i++) cachedCore.stepFrame(0, 0, false);
    const visMs = +((performance.now() - tVis) / 16).toFixed(2);
    const tHead = performance.now();
    for (let i = 0; i < 16; i++) cachedCore.stepFrame(0, 0, true);
    const headMs = +((performance.now() - tHead) / 16).toFixed(2);
    const tSl = performance.now();
    for (let i = 0; i < 8; i++) {
      cachedCore.saveStateInto(slot, i);
      cachedCore.loadStateFromSlot(slot);
    }
    const slMs = +((performance.now() - tSl) / 8).toFixed(2);
    const rb5Ms = +(slMs + 5 * headMs + visMs).toFixed(2);
    return { ok: true, bootMs, visMs, headMs, slMs, rb5Ms, hash60 };
  }

  async function runHttpStripedBenchmark(roomCode) {
    const kb = 512, u8 = makePseudoRandomBytes(kb, 0x13579bdf);
    const crc = crc32Hex(u8);
    const dlRoom = `${roomCode}_H1`, ulRoom = `${roomCode}_H2`;
    const ulUrl = `/api/room-rom?room=${encodeURIComponent(dlRoom)}` +
      `&crc=${crc}&name=bench512.zip`;
    await uploadStripedRom(ulUrl, u8, {
      'Content-Type': 'application/octet-stream'
    }, { concurrency: 8, sliceBytes: 65536, forceStriped: true });
    const resP = waitMsg('http_bench', 45000);
    ctx.sendWs({
      type: 'autotest_req_http_bench', dlRoom, ulRoom, expectedCrc: crc, kb
    });
    const res = await resP;
    if (!res) return { ok: false };
    const checkDl = await fetchStripedBinary(
      `/api/room-rom?room=${encodeURIComponent(ulRoom)}`,
      { concurrency: 8, probeBytes: 16384, sliceBytes: 65536 }
    );
    const ulMatch = Boolean(checkDl?.u8 && crc32Hex(checkDl.u8) === res.ulCrc);
    return {
      ok: Boolean(res.dlMatch && ulMatch), payloadKb: kb,
      singleDlKbps: res.singleDlKbps, stripeDlKbps: res.stripeDlKbps,
      speedup: res.speedup, pc2UploadKbps: res.pc2UploadKbps,
      firstDlPct: res.firstDlPct, firstUlPct: res.firstUlPct,
      crcOk: Boolean(res.dlMatch && ulMatch)
    };
  }

  async function handleHttpBenchRequest(msg) {
    const dlUrl = `/api/room-rom?room=${encodeURIComponent(msg.dlRoom)}`;
    const t1 = performance.now();
    const r1 = await fetch(`${dlUrl}&single=1`, { cache: 'no-store' });
    const b1 = new Uint8Array(await r1.arrayBuffer());
    const ms1 = Math.max(1, performance.now() - t1);
    const singleDlKbps = +((msg.kb / ms1) * 1000).toFixed(1);

    let firstDlPct = 0;
    const t8 = performance.now();
    const dl8 = await fetchStripedBinary(dlUrl, {
      concurrency: 8, probeBytes: 16384, sliceBytes: 65536,
      onProgress: (p) => { if (!firstDlPct && p > 0) firstDlPct = p; }
    });
    const ms8 = Math.max(1, performance.now() - t8);
    const stripeDlKbps = +((msg.kb / ms8) * 1000).toFixed(1);
    const dlMatch = Boolean(
      crc32Hex(b1) === msg.expectedCrc &&
      dl8?.u8 && crc32Hex(dl8.u8) === msg.expectedCrc
    );

    const upBytes = makePseudoRandomBytes(msg.kb, 0x2468ace1);
    const ulCrc = crc32Hex(upBytes);
    let firstUlPct = 0;
    const tUp = performance.now();
    await uploadStripedRom(
      `/api/room-rom?room=${encodeURIComponent(msg.ulRoom)}` +
        `&crc=${ulCrc}&name=pc2up.zip`,
      upBytes, { 'Content-Type': 'application/octet-stream' },
      {
        concurrency: 8, sliceBytes: 65536, forceStriped: true,
        onProgress: (p) => { if (!firstUlPct && p > 0) firstUlPct = p; }
      }
    );
    const msUp = Math.max(1, performance.now() - tUp);
    ctx.sendWs({
      type: 'autotest_res_http_bench', dlMatch, singleDlKbps, stripeDlKbps,
      speedup: +(stripeDlKbps / Math.max(1, singleDlKbps)).toFixed(2),
      pc2UploadKbps: +((msg.kb / msUp) * 1000).toFixed(1),
      firstDlPct, firstUlPct, ulCrc
    });
  }

  async function runWasmAndCpuBenchmark() {
    const remP = waitMsg('wasm_bench', 45000);
    ctx.sendWs({ type: 'autotest_req_wasm_bench' });
    const [pc1, pc2] = await Promise.all([measureLocalWasmAndCpu(), remP]);
    const hashMatch = Boolean(pc1?.ok && pc2?.ok && pc1.hash60 === pc2.hash60);
    return { ok: hashMatch, hashMatch, pc1, pc2 };
  }

  function advanceLiveTo(targetFrame, turboStart = 999) {
    return new Promise((resolve) => {
      const pIdx = liveEngine.localPlayer;
      const t0 = performance.now();
      const timer = setInterval(() => {
        if (!liveEngine || performance.now() - t0 > 15000) {
          clearInterval(timer);
          return resolve(false);
        }
        if (liveEngine.currentFrame < targetFrame) {
          const spd = liveEngine.currentFrame >= turboStart ? 4 : 1;
          const steps = Math.min(spd, targetFrame - liveEngine.currentFrame);
          for (let s = 0; s < steps; s++) {
            const isLast = s === steps - 1;
            const m = scriptedMask(pIdx, liveEngine.currentFrame);
            const r = liveEngine.stepNetplayFrame(m, 0, {
              turboSpeed: spd, skipRollback: s > 0, skipPacket: !isLast
            });
            if (isLast && r.packetToSend) ctx.sendDualWs(r.packetToSend);
          }
        } else {
          ctx.sendDualWs(
            liveEngine._buildInputPacket(liveEngine.lastLocalScheduledFrame)
          );
          if (liveEngine.lastConfirmedRemoteFrame >= targetFrame - 1) {
            liveEngine._executeRollbackIfNeeded();
            liveEngine._verifyConfirmedHashes();
            clearInterval(timer);
            resolve(true);
          }
        }
      }, 15);
    });
  }

  async function runLiveRollbackAndTurboBenchmark() {
    if (!cachedCore) await measureLocalWasmAndCpu();
    const sessionId = `lv_${Date.now().toString(36)}`;
    cachedCore.loadROM();
    liveEngine = new NesNetplayEngine(cachedCore, {
      localPlayer: 1, online: true, inputDelayFrames: 3, sessionId
    });
    const readyP = waitMsg('live_ready', 10000);
    const at80P = waitMsg('live_at80', 20000);
    ctx.sendWs({ type: 'autotest_live_init', sessionId, delay: 3 });
    if (!(await readyP)) return { ok: false };
    await Promise.all([advanceLiveTo(80, 40), at80P]);

    const syncState = {
      ...liveEngine.exportSyncState(), sessionId: `${sessionId}_s2`
    };
    liveEngine.importSyncState(syncState, { preserveLocalInputDelay: true });
    const ackP = waitMsg('live_sync_ack', 10000);
    const doneP = waitMsg('live_done', 20000);
    ctx.sendWs({ type: 'autotest_live_sync', syncState });
    const ack = await ackP;
    if (!ack) return { ok: false };
    await advanceLiveTo(110, 999);
    const rem = await doneP;
    const pc1Hash = formatHex32(cachedCore.computeHash());
    const hashMatch = Boolean(rem && pc1Hash === rem.hash110);
    return {
      ok: hashMatch && liveEngine.desyncCount === 0 && rem.desyncs === 0 &&
        Boolean(rem.syncImportOk),
      frames: 110, pc1Hash, pc2Hash: rem?.hash110 || '--', hashMatch,
      pc1Desyncs: liveEngine.desyncCount, pc2Desyncs: rem?.desyncs ?? -1,
      pc1Rollbacks: liveEngine.rollbacksTotal,
      pc2Rollbacks: rem?.rollbacks ?? 0,
      syncImportOk: Boolean(rem?.syncImportOk)
    };
  }

  async function handleMessage(msg) {
    if (msg.type === 'netplay_input') {
      if (!liveEngine || msg.sessionId !== liveEngine.sessionId) return true;
      const key = `${msg.sessionId}:${msg.startFrame}:${msg.inputs?.[0] || 0}`;
      if (key === lastRxDedup) return true;
      lastRxDedup = key;
      liveEngine.receiveRemoteInputPacket(msg, performance.now());
      return true;
    }
    if (msg.type === 'autotest_req_http_bench') {
      await handleHttpBenchRequest(msg); return true;
    }
    if (msg.type === 'autotest_res_http_bench') {
      resolveWaiter('http_bench', msg); return true;
    }
    if (msg.type === 'autotest_req_wasm_bench') {
      const res = await measureLocalWasmAndCpu();
      ctx.reportState.wasmLocal = res;
      ctx.sendWs({ type: 'autotest_res_wasm_bench', res });
      return true;
    }
    if (msg.type === 'autotest_res_wasm_bench') {
      resolveWaiter('wasm_bench', msg.res); return true;
    }
    if (msg.type === 'autotest_live_init') {
      if (!cachedCore) await measureLocalWasmAndCpu();
      cachedCore.loadROM();
      liveEngine = new NesNetplayEngine(cachedCore, {
        localPlayer: 2, online: true, inputDelayFrames: msg.delay || 3,
        sessionId: msg.sessionId
      });
      ctx.sendWs({ type: 'autotest_live_ready', sessionId: msg.sessionId });
      await advanceLiveTo(80, 40);
      ctx.sendWs({
        type: 'autotest_live_at80',
        hash80: formatHex32(cachedCore.computeHash())
      });
      return true;
    }
    if (msg.type === 'autotest_live_ready') {
      resolveWaiter('live_ready', msg); return true;
    }
    if (msg.type === 'autotest_live_at80') {
      resolveWaiter('live_at80', msg); return true;
    }
    if (msg.type === 'autotest_live_sync' && liveEngine) {
      const syncImportOk = liveEngine.importSyncState(
        msg.syncState, { preserveLocalInputDelay: true }
      );
      ctx.sendWs({ type: 'autotest_live_sync_ack', syncImportOk });
      await advanceLiveTo(110, 999);
      ctx.sendWs({
        type: 'autotest_live_done',
        hash110: formatHex32(cachedCore.computeHash()),
        desyncs: liveEngine.desyncCount,
        rollbacks: liveEngine.rollbacksTotal,
        syncImportOk
      });
      return true;
    }
    if (msg.type === 'autotest_live_sync_ack') {
      resolveWaiter('live_sync_ack', msg); return true;
    }
    if (msg.type === 'autotest_live_done') {
      resolveWaiter('live_done', msg); return true;
    }
    return false;
  }

  return {
    runHttpStripedBenchmark,
    runWasmAndCpuBenchmark,
    runLiveRollbackAndTurboBenchmark,
    handleMessage
  };
}
