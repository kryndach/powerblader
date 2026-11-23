/**
 * @fileoverview Data Transfer & 60Hz Packet Stream Tester for `/nettest`.
 *
 * Line width <= 80 chars, file size <= 350 lines.
 */

import { crc32Hex, uint8ToBase64, base64ToUint8 } from '/src/crc32.mjs';

export function computeGapStats(gaps) {
  if (!gaps || gaps.length === 0) {
    return { avg: 0, p95: 0, max: 0, clumpedPct: 0 };
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = +(sum / sorted.length).toFixed(1);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = +sorted[p95Idx].toFixed(1);
  const max = +sorted[sorted.length - 1].toFixed(1);
  const clumped = sorted.filter((g) => g < 3.0).length;
  const clumpedPct = Math.round((clumped / sorted.length) * 100);
  return { avg, p95, max, clumpedPct };
}

export function createNetDebugSuitesManager(ctx, webrtcMgr) {
  const { els, metrics, logEvent } = ctx;
  const incomingChunks = new Map();
  const pendingTransfers = new Map();
  let rxStreamState = {
    active: false,
    streamId: null,
    expectedCount: 300,
    receivedSeqs: new Set(),
    lastSeq: -1,
    outOfOrder: 0,
    duplicates: 0,
    lastRxTime: 0,
    gapsMs: []
  };
  let pendingStreamResolve = null;

  function addTransferRow(row) {
    metrics.transfers.unshift(row);
    if (metrics.transfers.length > 20) metrics.transfers.pop();
    els.transferTableBody.innerHTML = '';
    for (const r of metrics.transfers) {
      const tr = document.createElement('tr');
      const badgeClass = r.ok ? 'ok' : 'err';
      tr.innerHTML =
        `<td>${r.dir}</td>` +
        `<td><strong>${r.kb} KB</strong> (${r.mode})</td>` +
        `<td>${r.via}</td>` +
        `<td>${r.ms} ms (${r.kbps} KB/s)</td>` +
        `<td><code>${r.crc32}</code></td>` +
        `<td><span class="badge ${badgeClass}">${r.status}</span></td>`;
      els.transferTableBody.appendChild(tr);
    }
  }

  async function runDataTransferTest(kb, mode, via) {
    if (!ctx.isPeerConnected()) {
      logEvent('Connect 2nd PC before running data transfer tests.', 'warn');
      return { ok: false, status: 'NO PEER' };
    }
    const sendVia = via === 'auto' ? 'auto_reliable' : via;
    const byteLength = kb * 1024;
    const u8 = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i++) u8[i] = (i * 73 + 19) & 0xff;
    const crc = crc32Hex(u8);
    const xferId = `xf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const t0 = performance.now();
    const timeoutMs = Math.max(15000, kb * 120);

    logEvent(
      `Starting ${kb} KB (${mode}) transfer via ${via.toUpperCase()} ` +
        `[CRC=${crc}]...`
    );

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (pendingTransfers.has(xferId)) {
          pendingTransfers.delete(xferId);
          const row = {
            dir: 'TX → RX', kb, mode, via,
            ms: Math.round(performance.now() - t0),
            kbps: '0', crc32: crc, ok: false, status: 'TIMEOUT (Dropped)'
          };
          addTransferRow(row);
          logEvent(
            `Transfer ${kb} KB (${mode}) via ${via} TIMED OUT!`,
            'err'
          );
          resolve(row);
        }
      }, timeoutMs);

      pendingTransfers.set(xferId, {
        t0, kb, mode, via, crc32: crc, timeout, resolve
      });

      if (mode === 'single') {
        const sent = webrtcMgr.sendViaTransport(sendVia, {
          type: 'diag_xfer_single',
          xferId, kb, via, crc32: crc, dataB64: uint8ToBase64(u8)
        });
        if (!sent) {
          clearTimeout(timeout);
          pendingTransfers.delete(xferId);
          const row = {
            dir: 'TX', kb, mode, via, ms: 0, kbps: '0',
            crc32: crc, ok: false, status: 'CH CLOSED'
          };
          addTransferRow(row);
          resolve(row);
        }
      } else {
        const chunkSize = 16 * 1024;
        const totalChunks = Math.ceil(u8.length / chunkSize);
        webrtcMgr.sendViaTransport(sendVia, {
          type: 'diag_xfer_start',
          xferId, kb, via, totalChunks, totalBytes: u8.length, crc32: crc
        });
        for (let c = 0; c < totalChunks; c++) {
          const end = Math.min(u8.length, (c + 1) * chunkSize);
          const slice = u8.subarray(c * chunkSize, end);
          webrtcMgr.sendViaTransport(sendVia, {
            type: 'diag_xfer_chunk',
            xferId, index: c, dataB64: uint8ToBase64(slice)
          });
        }
        webrtcMgr.sendViaTransport(sendVia, { type: 'diag_xfer_end', xferId });
      }
    });
  }

  function handleXferMessage(msg, viaSource) {
    if (msg.type === 'diag_xfer_single') {
      const u8 = base64ToUint8(msg.dataB64 || '');
      const calcCrc = crc32Hex(u8);
      const crcMatch = calcCrc === msg.crc32;
      webrtcMgr.sendViaTransport(msg.via || viaSource, {
        type: 'diag_xfer_ack',
        xferId: msg.xferId, rxBytes: u8.length, rxCrc32: calcCrc, crcMatch
      });
      const viaUp = (msg.via || viaSource).toUpperCase();
      logEvent(
        `Received ${msg.kb} KB (single) via ${viaUp} — ` +
          `CRC ${crcMatch ? 'MATCH' : 'MISMATCH'}`,
        crcMatch ? 'ok' : 'err'
      );
      return true;
    }
    if (msg.type === 'diag_xfer_start') {
      incomingChunks.set(msg.xferId, {
        kb: msg.kb, via: msg.via || viaSource, totalChunks: msg.totalChunks,
        totalBytes: msg.totalBytes, expectedCrc: msg.crc32,
        chunks: new Map(), t0: performance.now()
      });
      return true;
    }
    if (msg.type === 'diag_xfer_chunk') {
      const st = incomingChunks.get(msg.xferId);
      if (st) st.chunks.set(msg.index, base64ToUint8(msg.dataB64));
      return true;
    }
    if (msg.type === 'diag_xfer_end') {
      const st = incomingChunks.get(msg.xferId);
      if (!st) return true;
      incomingChunks.delete(msg.xferId);
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
      const calcCrc = missing === 0 ? crc32Hex(full) : 'MISSING';
      const crcMatch = missing === 0 && calcCrc === st.expectedCrc;
      webrtcMgr.sendViaTransport(st.via || viaSource, {
        type: 'diag_xfer_ack',
        xferId: msg.xferId, rxBytes: offset, rxCrc32: calcCrc, crcMatch
      });
      const viaUp = (st.via || viaSource).toUpperCase();
      logEvent(
        `Reassembled ${st.kb} KB (${st.totalChunks} chunks) via ${viaUp} — ` +
          `CRC ${crcMatch ? 'OK' : 'FAIL'}`,
        crcMatch ? 'ok' : 'err'
      );
      return true;
    }
    if (msg.type === 'diag_xfer_ack') {
      const pend = pendingTransfers.get(msg.xferId);
      if (!pend) return true;
      clearTimeout(pend.timeout);
      pendingTransfers.delete(msg.xferId);
      const ms = Math.max(1, Math.round(performance.now() - pend.t0));
      const kbps = ((pend.kb / ms) * 1000).toFixed(1);
      const row = {
        dir: 'TX → RX', kb: pend.kb, mode: pend.mode, via: pend.via,
        ms, kbps, crc32: msg.rxCrc32, ok: Boolean(msg.crcMatch),
        status: msg.crcMatch ? 'PASS (CRC OK)' : 'CRC FAIL'
      };
      addTransferRow(row);
      logEvent(
        `Transfer ${pend.kb} KB (${pend.mode}) via ` +
          `${pend.via.toUpperCase()} verified in ${ms}ms (${kbps} KB/s)`,
        row.ok ? 'ok' : 'err'
      );
      pend.resolve(row);
      return true;
    }
    return false;
  }

  function applyStreamSummaryToUi(s) {
    els.streamProgressVal.textContent =
      `${s.received} / ${s.total} (Loss: ${s.lossPct}%)`;
    els.streamOrderVal.textContent = `${s.outOfOrder} / ${s.duplicates}`;
    els.streamGapVal.textContent =
      `${s.gaps.avg} / ${s.gaps.p95} / ${s.gaps.max} ms`;
    els.streamClumpVal.textContent = `${s.gaps.clumpedPct}%`;
  }

  async function run60HzStreamTest(via, totalFrames = 180) {
    if (!ctx.isPeerConnected()) {
      logEvent('Connect 2nd PC before running 60Hz stream test.', 'warn');
      return null;
    }
    const streamId = `st_${Date.now()}`;
    logEvent(
      `Starting 60Hz Packet Stream (${totalFrames} frames) via ` +
        `${via.toUpperCase()}...`
    );
    webrtcMgr.sendViaTransport(via, {
      type: 'diag_stream_start', streamId, via, totalFrames
    });

    return new Promise((resolve) => {
      let sent = 0;
      pendingStreamResolve = resolve;
      const timer = setInterval(() => {
        webrtcMgr.sendViaTransport(via, {
          type: 'diag_stream_pkt', streamId, seq: sent,
          t: performance.now(), pad1: sent & 0xff, pad2: (sent * 7) & 0xff
        });
        sent++;
        els.streamProgressVal.textContent = `Tx: ${sent}/${totalFrames}`;
        if (sent >= totalFrames) {
          clearInterval(timer);
          setTimeout(() => {
            webrtcMgr.sendViaTransport(via, {
              type: 'diag_stream_finish', streamId, totalFrames
            });
          }, 450);
        }
      }, 1000 / 60);

      setTimeout(() => {
        if (pendingStreamResolve === resolve) {
          pendingStreamResolve = null;
          resolve(null);
        }
      }, totalFrames * 17 + 5000);
    });
  }

  function handleStreamMessage(msg, viaSource) {
    if (msg.type === 'diag_stream_start') {
      rxStreamState = {
        active: true, streamId: msg.streamId, via: msg.via || viaSource,
        expectedCount: msg.totalFrames || 300, receivedSeqs: new Set(),
        lastSeq: -1, outOfOrder: 0, duplicates: 0, lastRxTime: 0, gapsMs: []
      };
      const viaUp = (msg.via || viaSource).toUpperCase();
      logEvent(
        `Receiving 60Hz stream (${rxStreamState.expectedCount} frames) ` +
          `via ${viaUp}...`
      );
      return true;
    }
    if (msg.type === 'diag_stream_pkt') {
      if (!rxStreamState.active || msg.streamId !== rxStreamState.streamId) {
        return true;
      }
      const now = performance.now();
      if (rxStreamState.lastRxTime > 0) {
        rxStreamState.gapsMs.push(now - rxStreamState.lastRxTime);
      }
      rxStreamState.lastRxTime = now;
      if (rxStreamState.receivedSeqs.has(msg.seq)) rxStreamState.duplicates++;
      else {
        rxStreamState.receivedSeqs.add(msg.seq);
        if (msg.seq < rxStreamState.lastSeq) rxStreamState.outOfOrder++;
        else rxStreamState.lastSeq = msg.seq;
      }
      return true;
    }
    if (msg.type === 'diag_stream_finish') {
      if (msg.streamId !== rxStreamState.streamId) return true;
      rxStreamState.active = false;
      const received = rxStreamState.receivedSeqs.size;
      const total = rxStreamState.expectedCount;
      const lossPct = +(((total - received) / total) * 100).toFixed(1);
      const gaps = computeGapStats(rxStreamState.gapsMs);
      const summary = {
        streamId: msg.streamId, via: rxStreamState.via, total, received,
        lossPct, outOfOrder: rxStreamState.outOfOrder,
        duplicates: rxStreamState.duplicates, gaps
      };
      metrics.lastStreamReport = summary;
      applyStreamSummaryToUi(summary);
      webrtcMgr.sendViaTransport(rxStreamState.via || viaSource, {
        type: 'diag_stream_summary', summary
      });
      return true;
    }
    if (msg.type === 'diag_stream_summary') {
      const s = msg.summary;
      metrics.lastStreamReport = s;
      applyStreamSummaryToUi(s);
      logEvent(
        `60Hz Stream Result (${s.via.toUpperCase()}): Rx ${s.received}/` +
          `${s.total} (Loss ${s.lossPct}%), AvgGap=${s.gaps.avg}ms, ` +
          `MaxGap=${s.gaps.max}ms, Clumped=${s.gaps.clumpedPct}%`,
        s.lossPct === 0 ? 'ok' : 'warn'
      );
      if (pendingStreamResolve) {
        const r = pendingStreamResolve;
        pendingStreamResolve = null;
        r(s);
      }
      return true;
    }
    return false;
  }

  return {
    runDataTransferTest,
    handleXferMessage,
    run60HzStreamTest,
    handleStreamMessage
  };
}
