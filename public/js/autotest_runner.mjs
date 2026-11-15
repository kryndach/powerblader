// Master 8-Stage Full-Stack Auto-Benchmark Coordinator for `/autotest` v3.0
import { calcStats } from './autotest_stages.mjs';
import { buildNetplayRecommendations } from './autotest_netplay_and_http.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runFullAutoBenchmark(
  ctx, stagesMgr, webrtcMgr, fullStackMgr, profiles
) {
  if (ctx.isSuiteRunning() || !ctx.isPeerConnected()) return;
  ctx.setSuiteRunning(true);
  Object.assign(ctx.reportState, {
    stages: [], webrtcProfiles: [], httpBench: null, wasmBench: null,
    liveNetplay: null, recommendations: null, overallStatus: 'RUNNING'
  });
  ctx.els.suiteBadge.className = 'badge info';
  ctx.els.suiteBadge.textContent = 'RUNNING...';
  ctx.els.stateBadge.className = 'badge info';
  ctx.els.stateText.textContent =
    'Running 8-Stage Full-Stack 2-PC Benchmark — please wait ~30 seconds...';

  const syncProgress = async (progress, complete = false) => {
    ctx.els.progressBar.style.width = `${progress}%`;
    ctx.renderTables();
    ctx.sendWs({
      type: 'autotest_sync',
      stages: ctx.reportState.stages,
      webrtcProfiles: ctx.reportState.webrtcProfiles,
      httpBench: ctx.reportState.httpBench,
      wasmBench: ctx.reportState.wasmBench,
      liveNetplay: ctx.reportState.liveNetplay,
      recommendations: ctx.reportState.recommendations,
      progress,
      complete
    });
    await ctx.uploadReportToServer(complete);
  };

  const beginStage = (name, summary) => {
    const st = { name, status: 'RUNNING', summary };
    ctx.reportState.stages.push(st);
    ctx.renderTables();
    return st;
  };

  ctx.log('=== STARTING 8-STAGE 2-PC FULL-STACK BENCHMARK (v3.0) ===');
  await syncProgress(6);

  // STAGE 1: Baseline WSS Relay + Dual-WS (wsAux) Check
  const stage1 = beginStage(
    '1. Baseline WSS + Dual-WS Check (15x)',
    'Verifying wsAux binding & measuring server/peer RTT...'
  );
  for (let w = 0; w < 12 && !ctx.reportState.dualWsOk; w++) await sleep(100);
  const srvRtt = await stagesMgr.measureServerRtt();
  ctx.reportState.serverRttMs = srvRtt;
  ctx.sendWs({ type: 'autotest_req_srv_rtt' });

  const basePings = [];
  for (let i = 0; i < 15; i++) {
    const r = await stagesMgr.measurePeerRttViaWs(3500);
    if (r !== null) basePings.push(r);
    await sleep(35);
  }
  const baseStats = calcStats(basePings);
  ctx.reportState.wssRttMs = baseStats.avg;
  ctx.reportState.wssJitterMs = baseStats.jitter;
  const dualTag = ctx.reportState.dualWsOk ? 'BOUND' : 'SINGLE';
  stage1.status =
    baseStats.count >= 12 ? 'PASS' : baseStats.count > 0 ? 'WARN' : 'FAIL';
  stage1.summary =
    `DualWS=${dualTag} | Server=${srvRtt ?? '--'}ms | ` +
    `Peer Avg=${baseStats.avg ?? '--'}ms (Min=${baseStats.min}ms, ` +
    `P95=${baseStats.p95}ms, Jitter=±${baseStats.jitter}ms)`;
  ctx.log(`Stage 1: ${stage1.summary}`);
  await syncProgress(16);

  // STAGE 2: WebRTC P2P & STUN/TURN Discovery Matrix
  const stage2 = beginStage(
    '2. WebRTC P2P & STUN/TURN Matrix (3 Profiles)',
    'Testing RU-SIP STUN, Port-443 STUN & Public TURN...'
  );
  let winningProfile = null;
  for (const prof of profiles) {
    const res = await webrtcMgr.testSingleWebRtcProfile(prof);
    if (res.open && !winningProfile) { winningProfile = res; break; }
  }
  if (winningProfile) {
    stage2.status = 'PASS';
    stage2.summary =
      `P2P OPEN via "${winningProfile.name}" ` +
      `(${winningProfile.selectedPair}, RTT=${winningProfile.rttMs}ms)`;
    ctx.reportState.activeTransport =
      `WebRTC P2P (${winningProfile.selectedPair})`;
    ctx.els.p2pBadge.className = 'badge ok';
    ctx.els.p2pBadge.textContent = `P2P OPEN (${winningProfile.rttMs}ms)`;
  } else {
    stage2.status = 'WARN';
    stage2.summary =
      `UDP/TURN blocked by ISP/NAT — Dual-WSS active (${baseStats.avg}ms)`;
    ctx.reportState.activeTransport = ctx.reportState.dualWsOk
      ? 'Dual-WSS Relay' : 'WSS Relay';
    ctx.els.p2pBadge.className = 'badge warn';
    ctx.els.p2pBadge.textContent = 'UDP BLOCKED (DUAL-WSS)';
  }
  ctx.log(`Stage 2: ${stage2.summary}`);
  await syncProgress(30);

  // STAGE 3: Bidirectional 60Hz Dual-WS Input Stream
  const stage3 = beginStage(
    '3. Bidirectional 60Hz Dual-WS Input Stream (3s)',
    'Streaming 180 frames at 60fps across ws + wsAux...'
  );
  stagesMgr.startRxStream(180);
  const remStreamP = new Promise((resolve) => {
    const t = setTimeout(() => {
      stagesMgr.setRemoteStreamSummaryWaiter(null);
      resolve(null);
    }, 10000);
    stagesMgr.setRemoteStreamSummaryWaiter((s) => {
      clearTimeout(t);
      resolve(s);
    });
  });
  ctx.sendWs({ type: 'autotest_start_bidir_stream', totalFrames: 180 });
  await stagesMgr.startLocal60HzTx(180);
  const pc1ToPc2 = await remStreamP;
  await sleep(200);
  const rxStream = stagesMgr.getRxStream();
  const pc2Gaps = calcStats(rxStream.gaps);
  const pc2Rx = rxStream.seqs.size;
  if (pc1ToPc2) {
    stage3.status = pc1ToPc2.rx >= 175 && pc2Rx >= 175 ? 'PASS' : 'WARN';
    stage3.summary =
      `PC1→PC2: ${pc1ToPc2.rx}/180 (MaxGap=${pc1ToPc2.maxGap}ms, ` +
      `Clump=${pc1ToPc2.clumpPct}%) | PC2→PC1: ${pc2Rx}/180 ` +
      `(MaxGap=${Math.round(pc2Gaps.max ?? 0)}ms)`;
  } else {
    stage3.status = pc2Rx >= 175 ? 'WARN' : 'FAIL';
    stage3.summary = `PC2→PC1: ${pc2Rx}/180 | PC1→PC2 report timeout`;
  }
  ctx.log(`Stage 3: ${stage3.summary}`);
  await syncProgress(44);

  // STAGE 4: WS Chunked Transfers (16 KB + 64 KB + 256 KB + Tail Ping)
  const stage4 = beginStage(
    '4. WS Chunked Transfers (16/64/256 KB + Ping)',
    'Testing WebSocket framing & concurrent ping under load...'
  );
  const xf16 = await stagesMgr.runChunkedTransferBenchmark(16, 16);
  const xf64 = await stagesMgr.runChunkedTransferBenchmark(64, 16);
  const xf256 = await stagesMgr.runChunkedTransferBenchmark(256, 16);
  const tailPing = await stagesMgr.measurePeerRttViaWs(3500);
  stage4.status = xf16.ok && xf64.ok && xf256.ok ? 'PASS' : 'FAIL';
  stage4.summary =
    `16KB=${xf16.kbps} KB/s | 64KB=${xf64.kbps} KB/s | ` +
    `256KB=${xf256.kbps} KB/s (CRC=${xf256.crc32}) | ` +
    `TailPing=${tailPing ?? '--'}ms`;
  ctx.log(`Stage 4: ${stage4.summary}`);
  await syncProgress(58);

  // STAGE 5: Striped HTTP Range Download & Multipart Upload (/api/room-rom)
  const stage5 = beginStage(
    '5. Striped HTTP ROM Transfer (1x vs 8x Range + Upload)',
    'Comparing 1-stream vs 8-stream Range DL & PC2 multipart upload...'
  );
  const hb = await fullStackMgr.runHttpStripedBenchmark(ctx.roomCode);
  ctx.reportState.httpBench = hb;
  stage5.status = hb.ok ? 'PASS' : 'FAIL';
  stage5.summary = hb.ok
    ? `1x DL=${hb.singleDlKbps} KB/s → 8x DL=${hb.stripeDlKbps} KB/s ` +
      `(${hb.speedup}x, 1st=${hb.firstDlPct}%) | ` +
      `PC2 8x UL=${hb.pc2UploadKbps} KB/s (1st=${hb.firstUlPct}%, CRC=OK)`
    : 'Striped HTTP /api/room-rom benchmark failed or timed out';
  ctx.log(`Stage 5: ${stage5.summary}`);
  await syncProgress(72);

  // STAGE 6: Real FBNeo Arcade WASM Determinism & CPU 5f-Rollback
  const stage6 = beginStage(
    '6. Arcade WASM (FBNeo) Determinism & CPU 5f-Rollback',
    'Booting fbneo_arcade.wasm on both PCs & checking 60f hash + CPU...'
  );
  const wb = await fullStackMgr.runWasmAndCpuBenchmark();
  ctx.reportState.wasmBench = wb;
  const cpuWarn = (wb.pc1?.rb5Ms ?? 99) >= 35 || (wb.pc2?.rb5Ms ?? 99) >= 35;
  stage6.status = !wb.hashMatch ? 'FAIL' : cpuWarn ? 'WARN' : 'PASS';
  stage6.summary = wb.hashMatch
    ? `Hash60=${wb.pc1.hash60} (EXACT MATCH) | ` +
      `PC1 5f-RB=${wb.pc1.rb5Ms}ms (Boot=${wb.pc1.bootMs}ms) | ` +
      `PC2 5f-RB=${wb.pc2.rb5Ms}ms (Boot=${wb.pc2.bootMs}ms)`
    : `WASM Determinism Failure (PC1=${wb.pc1?.hash60}, PC2=${wb.pc2?.hash60})`;
  ctx.log(`Stage 6: ${stage6.summary}`);
  await syncProgress(86);

  // STAGE 7: Live 2-PC Rollback Engine, 4x Turbo & Mid-Game State Sync
  const stage7 = beginStage(
    '7. Live 2-PC Rollback, 4x Turbo & State Sync (110f)',
    'Running live Dual-WS rollback + 4x Turbo + ZRLE state sync...'
  );
  const ln = await fullStackMgr.runLiveRollbackAndTurboBenchmark();
  ctx.reportState.liveNetplay = ln;
  stage7.status = ln.ok ? 'PASS' : 'FAIL';
  stage7.summary = ln.ok
    ? `110f Hash=${ln.pc1Hash} (SYNC_OK) | Desyncs=0/0 | ` +
      `Rollbacks=${ln.pc1Rollbacks}/${ln.pc2Rollbacks} | MidGameSync=OK`
    : `Live Netplay Failed (Hash=${ln.pc1Hash}/${ln.pc2Hash}, ` +
      `Desyncs=${ln.pc1Desyncs}/${ln.pc2Desyncs})`;
  ctx.log(`Stage 7: ${stage7.summary}`);
  await syncProgress(94);

  // STAGE 8: Cooldown Ping & Auto-Tuned Netplay Verdict
  const stage8 = beginStage(
    '8. Cooldown Ping & Auto-Tuned Verdict (10x)',
    'Verifying post-load ping & computing optimal input delay...'
  );
  await sleep(150);
  const postPings = [];
  for (let i = 0; i < 10; i++) {
    const r = await stagesMgr.measurePeerRttViaWs(3500);
    if (r !== null) postPings.push(r);
    await sleep(35);
  }
  const postStats = calcStats(postPings);
  const delta = postStats.avg !== null && baseStats.avg !== null
    ? postStats.avg - baseStats.avg : null;
  const rec = buildNetplayRecommendations(ctx.reportState, pc1ToPc2);
  ctx.reportState.recommendations = rec;
  stage8.status = postStats.avg === null
    ? 'FAIL' : Math.abs(delta ?? 0) < 180 ? 'PASS' : 'WARN';
  const dStr = delta !== null ? `${delta >= 0 ? '+' : ''}${delta}ms` : '--';
  stage8.summary =
    `Cooldown=${postStats.avg ?? '--'}ms (Delta=${dStr}) | ` +
    `Recommended: ${rec.transport}, NES=${rec.nesDelayFrames}f, ` +
    `Arcade=${rec.arcadeDelayFrames}f`;
  ctx.log(`Stage 8: ${stage8.summary}`);

  ctx.reportState.overallStatus = 'COMPLETE';
  ctx.els.suiteBadge.className = 'badge ok';
  ctx.els.suiteBadge.textContent = 'COMPLETE';
  ctx.els.stateBadge.className = 'badge ok';
  ctx.els.stateBadge.textContent = 'BENCHMARK COMPLETE';
  ctx.els.stateText.textContent =
    'All 8 benchmark stages finished and auto-saved to ' +
    'logs/autotest_latest.txt!';
  ctx.log('=== 8-STAGE 2-PC FULL-STACK BENCHMARK COMPLETE ===');
  await syncProgress(100, true);
  ctx.setSuiteRunning(false);
}
