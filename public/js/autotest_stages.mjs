/**
 * @fileoverview 6-Stage Automated 2-PC Benchmark Runner for `/autotest`.
 *
 * Line width <= 80 chars, file size <= 350 lines.
 */

import {
  crc32Hex,
  uint8ToBase64,
  base64ToUint8
} from '/src/crc32.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const jitter =
    valid.length > 1 ? Math.round(jitSum / (valid.length - 1)) : 0;
  return { count: valid.length, min, avg, med, p95, max, jitter };
}

export function createAutotestStagesManager(ctx, webrtcMgr, profiles) {
  let serverPingWaiter = null;
  const peerPingWaiters = new Map();
  let rxStream = {
    active: false,
    total: 180,
    seqs: new Set(),
    gaps: [],
    lastAt: 0,
    reported: false
  };
  let remoteStreamSummaryWaiter = null;
  const incomingXfers = new Map();
  const pendingXferWaiters = new Map();

  function measureServerRtt() {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const timeout = setTimeout(() => {
        serverPingWaiter = null;
        resolve(null);
      }, 3000);
      serverPingWaiter = () => {
        clearTimeout(timeout);
        resolve(Math.max(1, Math.round(performance.now() - t0)));
      };
      ctx.sendWs({ type: 'ping', t: Date.now() });
    });
  }

  function resolveServerPong() {
    if (serverPingWaiter) {
      const w = serverPingWaiter;
      serverPingWaiter = null;
      w();
    }
  }

  function measurePeerRttViaWs(timeoutMs = 4000) {
    return new Promise((resolve) => {
      const pingId =
        `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const t0 = performance.now();
      const timer = setTimeout(() => {
        peerPingWaiters.delete(pingId);
        resolve(null);
      }, timeoutMs);
      peerPingWaiters.set(pingId, () => {
        clearTimeout(timer);
        resolve(Math.max(1, Math.round(performance.now() - t0)));
      });
      ctx.sendWs({ type: 'autotest_ping', pingId, t: t0 });
    });
  }

  function resolvePeerPong(pingId) {
    const w = peerPingWaiters.get(pingId);
    if (w) {
      peerPingWaiters.delete(pingId);
      w();
    }
  }

  function sendStreamReportIfNeeded() {
    if (rxStream.reported) return;
    rxStream.reported = true;
    rxStream.active = false;
    const g = calcStats(rxStream.gaps);
    const clumped = rxStream.gaps.filter((x) => x < 5.0).length;
    const clumpPct =
      rxStream.gaps.length > 0
        ? Math.round((clumped / rxStream.gaps.length) * 100)
        : 0;
    ctx.sendWs({
      type: 'autotest_stream_report',
      rx: rxStream.seqs.size,
      total: rxStream.total,
      maxGap: Math.round(g.max ?? 0),
      avgGap: Math.round(g.avg ?? 0),
      clumpPct
    });
  }

  function startLocal60HzTx(totalFrames = 180) {
    return new Promise((resolve) => {
      let sent = 0;
      const batchSize = 3;
      const timer = setInterval(() => {
        const frames = [];
        for (let k = 0; k < batchSize && sent < totalFrames; k++) {
          frames.push({
            seq: sent,
            p1: sent & 0xff,
            p2: (sent * 3) & 0xff
          });
          sent++;
        }
        (ctx.sendDualWs || ctx.sendWs)({
          type: 'autotest_stream_pkt',
          seq: frames[0].seq,
          frames,
          t: performance.now()
        });
        if (sent >= totalFrames) {
          clearInterval(timer);
          setTimeout(() => {
            ctx.sendWs({ type: 'autotest_stream_done', totalFrames });
            resolve();
          }, 250);
        }
      }, 50);
    });
  }

  function startRxStream(totalFrames = 180) {
    rxStream = {
      active: true,
      total: totalFrames,
      seqs: new Set(),
      gaps: [],
      lastAt: 0,
      reported: false
    };
  }

  function handleStreamPacket(msg) {
    if (!rxStream.active) return;
    if (typeof msg.seq === 'number' && rxStream.seqs.has(msg.seq)) return;
    const now = performance.now();
    if (rxStream.lastAt > 0) rxStream.gaps.push(now - rxStream.lastAt);
    rxStream.lastAt = now;
    if (Array.isArray(msg.frames)) {
      for (const f of msg.frames) rxStream.seqs.add(f.seq);
    } else if (typeof msg.seq === 'number') {
      rxStream.seqs.add(msg.seq);
    }
    if (rxStream.seqs.size >= rxStream.total) {
      sendStreamReportIfNeeded();
    }
  }

  function handleStreamReport(msg) {
    if (remoteStreamSummaryWaiter) {
      const w = remoteStreamSummaryWaiter;
      remoteStreamSummaryWaiter = null;
      w(msg);
    }
  }

  function checkCompleteIncomingXfer(xferId) {
    const st = incomingXfers.get(xferId);
    if (!st || st.chunks.size < st.totalChunks) return;
    incomingXfers.delete(xferId);
    const full = new Uint8Array(st.totalBytes);
    let offset = 0;
    let missing = 0;
    for (let i = 0; i < st.totalChunks; i++) {
      const part = st.chunks.get(i);
      if (!part) missing++;
      else {
        full.set(part, offset);
        offset += part.length;
      }
    }
    const rxCrc32 = missing === 0 ? crc32Hex(full) : 'MISSING';
    const crcMatch = missing === 0 && rxCrc32 === st.expectedCrc;
    ctx.log(
      `Received ${st.kb} KB (${st.totalChunks} chunks) — ` +
        `CRC ${crcMatch ? 'OK' : 'FAIL'}`
    );
    ctx.sendWs({ type: 'diag_xfer_ack', xferId, rxCrc32, crcMatch });
  }

  function handleXferStart(msg) {
    incomingXfers.set(msg.xferId, {
      kb: msg.kb,
      totalChunks: msg.totalChunks,
      totalBytes: msg.totalBytes,
      expectedCrc: msg.crc32,
      chunks: new Map(),
      endSeen: false
    });
  }

  function handleXferChunk(msg) {
    const st = incomingXfers.get(msg.xferId);
    if (st) {
      st.chunks.set(msg.index, base64ToUint8(msg.dataB64));
      if (st.chunks.size >= st.totalChunks) {
        checkCompleteIncomingXfer(msg.xferId);
      }
    }
  }

  function handleXferEnd(msg) {
    const st = incomingXfers.get(msg.xferId);
    if (!st) return;
    st.endSeen = true;
    checkCompleteIncomingXfer(msg.xferId);
  }

  function handleXferAck(msg) {
    const w = pendingXferWaiters.get(msg.xferId);
    if (w) {
      pendingXferWaiters.delete(msg.xferId);
      w(msg);
    }
  }

  async function runChunkedTransferBenchmark(kb, chunkKb = 16) {
    const totalBytes = kb * 1024;
    const chunkSize = chunkKb * 1024;
    const totalChunks = Math.ceil(totalBytes / chunkSize);
    const u8 = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes; i++) u8[i] = (i * 73 + 19) & 0xff;
    const crc = crc32Hex(u8);
    const xferId = `ax_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const t0 = performance.now();

    return new Promise((resolve) => {
      const timeoutMs = Math.max(30000, kb * 180);
      const timer = setTimeout(() => {
        pendingXferWaiters.delete(xferId);
        resolve({
          ok: false,
          kb,
          ms: Math.round(performance.now() - t0),
          kbps: 0,
          status: 'TIMEOUT'
        });
      }, timeoutMs);

      pendingXferWaiters.set(xferId, (ack) => {
        clearTimeout(timer);
        const ms = Math.max(1, Math.round(performance.now() - t0));
        const kbps = +((kb / ms) * 1000).toFixed(1);
        resolve({
          ok: Boolean(ack.crcMatch),
          kb,
          ms,
          kbps,
          crc32: ack.rxCrc32,
          status: ack.crcMatch ? 'PASS' : 'CRC_FAIL'
        });
      });

      ctx.sendWs({
        type: 'diag_xfer_start',
        xferId,
        kb,
        totalChunks,
        totalBytes,
        crc32: crc
      });
      for (let c = 0; c < totalChunks; c++) {
        const end = Math.min(totalBytes, (c + 1) * chunkSize);
        const slice = u8.subarray(c * chunkSize, end);
        ctx.sendWs({
          type: 'diag_xfer_chunk',
          xferId,
          index: c,
          dataB64: uint8ToBase64(slice)
        });
      }
      ctx.sendWs({ type: 'diag_xfer_end', xferId });
    });
  }

  return {
    measureServerRtt,
    resolveServerPong,
    measurePeerRttViaWs,
    resolvePeerPong,
    startLocal60HzTx,
    sendStreamReportIfNeeded,
    startRxStream,
    getRxStream: () => rxStream,
    setRemoteStreamSummaryWaiter: (fn) => {
      remoteStreamSummaryWaiter = fn;
    },
    handleStreamPacket,
    handleStreamReport,
    handleXferStart,
    handleXferChunk,
    handleXferEnd,
    handleXferAck,
    runChunkedTransferBenchmark,
    profiles
  };
}
