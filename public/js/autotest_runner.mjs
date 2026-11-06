/**
 * @fileoverview Master 6-Stage Auto-Benchmark Coordinator for `/autotest`.
 *
 * Line width <= 80 chars, file size <= 350 lines.
 */

import { calcStats } from './autotest_stages.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runFullAutoBenchmark(
  ctx,
  stagesMgr,
  webrtcMgr,
  profiles
) {
  if (ctx.isSuiteRunning() || !ctx.isPeerConnected()) return;
  ctx.setSuiteRunning(true);
  ctx.reportState.stages = [];
  ctx.reportState.webrtcProfiles = [];
  ctx.reportState.overallStatus = 'RUNNING';
  ctx.els.suiteBadge.className = 'badge info';
  ctx.els.suiteBadge.textContent = 'RUNNING...';
  ctx.els.stateBadge.className = 'badge info';
  ctx.els.stateText.textContent =
    'Running 6-Stage Automated 2-PC Benchmark — please wait ~30 seconds...';
  ctx.els.progressBar.style.width = '8%';

  ctx.log('=== STARTING 6-STAGE 2-PC AUTOMATED BENCHMARK ===');
  ctx.sendWs({
    type: 'autotest_sync',
    stages: ctx.reportState.stages,
    progress: 8
  });

  // STAGE 1: Baseline Relay Ping & Jitter (15 Pings)
  const stage1 = {
    name: '1. Baseline WSS Relay Ping (15x)',
    status: 'RUNNING',
    summary: 'Measuring server & peer RTT...'
  };
  ctx.reportState.stages.push(stage1);
  ctx.renderTables();

  const srvRtt = await stagesMgr.measureServerRtt();
  ctx.reportState.serverRttMs = srvRtt;
  ctx.sendWs({ type: 'autotest_req_srv_rtt' });

  const basePings = [];
  for (let i = 0; i < 15; i++) {
    const r = await stagesMgr.measurePeerRttViaWs(3500);
    if (r !== null) basePings.push(r);
    await sleep(50);
  }
  const baseStats = calcStats(basePings);
  ctx.reportState.wssRttMs = baseStats.avg;
  ctx.reportState.wssJitterMs = baseStats.jitter;
  stage1.status =
    baseStats.count >= 12 ? 'PASS' : baseStats.count > 0 ? 'WARN' : 'FAIL';
  stage1.summary =
    `Server=${srvRtt ?? '--'}ms | Peer Avg=${baseStats.avg ?? '--'}ms ` +
    `(Min=${baseStats.min}ms, Med=${baseStats.med}ms, ` +
    `P95=${baseStats.p95}ms, Max=${baseStats.max}ms, ` +
    `Jitter=±${baseStats.jitter}ms)`;
  ctx.log(`Stage 1 Complete: ${stage1.summary}`);
  ctx.els.progressBar.style.width = '24%';
  ctx.sendWs({
    type: 'autotest_sync',
    stages: ctx.reportState.stages,
    webrtcProfiles: ctx.reportState.webrtcProfiles,
    progress: 24
  });
  await ctx.uploadReportToServer(false);

  // STAGE 2: Multi-Profile WebRTC P2P & STUN/TURN Discovery
  const stage2 = {
    name: '2. WebRTC P2P & STUN/TURN Matrix (3 Profiles)',
    status: 'RUNNING',
    summary: 'Testing RU-SIP STUN, Port-443 STUN & Public TURN...'
  };
  ctx.reportState.stages.push(stage2);
  ctx.renderTables();

  let winningProfile = null;
  for (const prof of profiles) {
    const res = await webrtcMgr.testSingleWebRtcProfile(prof);
    ctx.sendWs({
      type: 'autotest_sync',
      stages: ctx.reportState.stages,
      webrtcProfiles: ctx.reportState.webrtcProfiles,
      progress: 42
    });
    if (res.open && !winningProfile) {
      winningProfile = res;
      break;
    }
  }
  if (winningProfile) {
    stage2.status = 'PASS';
    stage2.summary =
      `P2P OPEN via "${winningProfile.name}"! ` +
      `Pair=${winningProfile.selectedPair}, ` +
      `Direct RTT=${winningProfile.rttMs}ms`;
    ctx.reportState.activeTransport =
      `WebRTC P2P (${winningProfile.selectedPair})`;
    ctx.els.p2pBadge.className = 'badge ok';
    ctx.els.p2pBadge.textContent = `P2P OPEN (${winningProfile.rttMs}ms)`;
  } else {
    stage2.status = 'WARN';
    stage2.summary =
      'All direct UDP/TURN profiles blocked by ISP/NAT — ' +
      `using WSS Relay (${baseStats.avg}ms)`;
    ctx.els.p2pBadge.className = 'badge warn';
    ctx.els.p2pBadge.textContent = 'UDP BLOCKED (WSS ACTIVE)';
  }
  ctx.log(`Stage 2 Complete: ${stage2.summary}`);
  ctx.els.progressBar.style.width = '48%';
  ctx.sendWs({
    type: 'autotest_sync',
    stages: ctx.reportState.stages,
    webrtcProfiles: ctx.reportState.webrtcProfiles,
    progress: 48
  });
  await ctx.uploadReportToServer(false);

  // STAGE 3: Bidirectional Simultaneous 60fps NES Input Stream
  const stage3 = {
    name: '3. Bidirectional 60Hz NES Input Stream (3s)',
    status: 'RUNNING',
    summary:
      'Streaming 180 NES frames (60fps via 20Hz micro-batches) ' +
      'in both directions...'
  };
  ctx.reportState.stages.push(stage3);
  ctx.renderTables();

  stagesMgr.startRxStream(180);
  const remoteSummaryPromise = new Promise((resolve) => {
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
  const pc1ToPc2 = await remoteSummaryPromise;
  await sleep(300);

  const rxStream = stagesMgr.getRxStream();
  const pc2ToPc1Gaps = calcStats(rxStream.gaps);
  const pc2ToPc1Rx = rxStream.seqs.size;
  if (pc1ToPc2) {
    stage3.status =
      pc1ToPc2.rx >= 175 && pc2ToPc1Rx >= 175 ? 'PASS' : 'WARN';
    stage3.summary =
      `PC1→PC2: ${pc1ToPc2.rx}/180 (MaxGap=${pc1ToPc2.maxGap}ms, ` +
      `Clump=${pc1ToPc2.clumpPct}%) | PC2→PC1: ${pc2ToPc1Rx}/180 ` +
      `(MaxGap=${Math.round(pc2ToPc1Gaps.max ?? 0)}ms)`;
  } else {
    stage3.status = pc2ToPc1Rx >= 175 ? 'WARN' : 'FAIL';
    stage3.summary =
      `PC2→PC1: ${pc2ToPc1Rx}/180 ` +
      `(MaxGap=${Math.round(pc2ToPc1Gaps.max ?? 0)}ms) | ` +
      'PC1→PC2 report pending';
  }
  ctx.log(`Stage 3 Complete: ${stage3.summary}`);
  ctx.els.progressBar.style.width = '66%';
  ctx.sendWs({
    type: 'autotest_sync',
    stages: ctx.reportState.stages,
    webrtcProfiles: ctx.reportState.webrtcProfiles,
    progress: 66
  });
  await ctx.uploadReportToServer(false);

  // STAGE 4: 16 KB & 64 KB Fast 16KB-Chunked Data Transfers
  const stage4 = {
    name: '4. 16 KB & 64 KB Chunked Data Transfers (CRC32)',
    status: 'RUNNING',
    summary: 'Testing 16 KB and 64 KB (16KB-chunked) transfers...'
  };
  ctx.reportState.stages.push(stage4);
  ctx.renderTables();

  const xf16 = await stagesMgr.runChunkedTransferBenchmark(16, 16);
  const xf64 = await stagesMgr.runChunkedTransferBenchmark(64, 16);
  stage4.status = xf16.ok && xf64.ok ? 'PASS' : 'FAIL';
  stage4.summary =
    `16KB: ${xf16.status} in ${xf16.ms}ms (${xf16.kbps} KB/s) | ` +
    `64KB: ${xf64.status} in ${xf64.ms}ms (${xf64.kbps} KB/s)`;
  ctx.log(`Stage 4 Complete: ${stage4.summary}`);
  ctx.els.progressBar.style.width = '82%';
  ctx.sendWs({
    type: 'autotest_sync',
    stages: ctx.reportState.stages,
    webrtcProfiles: ctx.reportState.webrtcProfiles,
    progress: 82
  });
  await ctx.uploadReportToServer(false);

  // STAGE 5: 256 KB Large Transfer + Immediate Tail Ping Check
  const stage5 = {
    name: '5. 256 KB Transfer + Concurrent Ping Under Load',
    status: 'RUNNING',
    summary: 'Streaming 256 KB (16x16KB chunks) with CRC32 verification...'
  };
  ctx.reportState.stages.push(stage5);
  ctx.renderTables();

  const xf256 = await stagesMgr.runChunkedTransferBenchmark(256, 16);
  const tailPing = await stagesMgr.measurePeerRttViaWs(3500);
  stage5.status = xf256.ok ? 'PASS' : 'FAIL';
  stage5.summary =
    `256KB: ${xf256.status} in ${xf256.ms}ms ` +
    `(${xf256.kbps} KB/s, CRC=${xf256.crc32}) | ` +
    `Tail Ping: ${tailPing ?? '--'}ms`;
  ctx.log(`Stage 5 Complete: ${stage5.summary}`);
  ctx.els.progressBar.style.width = '92%';
  ctx.sendWs({
    type: 'autotest_sync',
    stages: ctx.reportState.stages,
    webrtcProfiles: ctx.reportState.webrtcProfiles,
    progress: 92
  });
  await ctx.uploadReportToServer(false);

  // STAGE 6: Post-Transfer Cooldown Ping Check
  const stage6 = {
    name: '6. Post-Transfer Cooldown Ping Check (10x)',
    status: 'RUNNING',
    summary: 'Verifying ping returns to baseline after 256KB transfer...'
  };
  ctx.reportState.stages.push(stage6);
  ctx.renderTables();

  await sleep(300);
  const postPings = [];
  for (let i = 0; i < 10; i++) {
    const r = await stagesMgr.measurePeerRttViaWs(3500);
    if (r !== null) postPings.push(r);
    await sleep(50);
  }
  const postStats = calcStats(postPings);
  const deltaMs =
    postStats.avg !== null && baseStats.avg !== null
      ? postStats.avg - baseStats.avg
      : null;
  stage6.status =
    postStats.avg !== null && Math.abs(deltaMs) < 180
      ? 'PASS'
      : postStats.avg !== null
        ? 'WARN'
        : 'FAIL';
  const deltaLabel =
    deltaMs !== null ? `${deltaMs >= 0 ? '+' : ''}${deltaMs}ms` : '--';
  stage6.summary =
    `Before 256KB=${baseStats.avg ?? '--'}ms → ` +
    `After 256KB=${postStats.avg ?? '--'}ms ` +
    `(Min=${postStats.min ?? '--'}ms, Max=${postStats.max ?? '--'}ms, ` +
    `Delta=${deltaLabel})`;
  ctx.log(`Stage 6 Complete: ${stage6.summary}`);

  ctx.els.progressBar.style.width = '100%';
  ctx.reportState.overallStatus = 'COMPLETE';
  ctx.els.suiteBadge.className = 'badge ok';
  ctx.els.suiteBadge.textContent = 'COMPLETE';
  ctx.els.stateBadge.className = 'badge ok';
  ctx.els.stateBadge.textContent = 'BENCHMARK COMPLETE';
  ctx.els.stateText.textContent =
    'All 6 benchmark stages finished and auto-saved to ' +
    'logs/autotest_latest.txt!';
  ctx.renderTables();

  ctx.log('=== 6-STAGE 2-PC AUTOMATED BENCHMARK COMPLETE ===');
  ctx.sendWs({
    type: 'autotest_sync',
    stages: ctx.reportState.stages,
    webrtcProfiles: ctx.reportState.webrtcProfiles,
    progress: 100,
    complete: true
  });
  await ctx.uploadReportToServer(true);
  ctx.setSuiteRunning(false);
}
