/**
 * @fileoverview 5-Stage Auto Diagnostic Suite & 2-PC Live Arena for `/nettest`.
 *
 * Line width <= 80 chars, file size <= 350 lines.
 */

export function createNetDebugArenaManager(ctx, webrtcMgr, suitesMgr) {
  const { els, metrics, logEvent } = ctx;
  const arenaCtx = els.arenaCanvas.getContext('2d');
  const localArena = {
    x: 80, y: 85, btn: 0, seq: 0, txCountThisSec: 0, txPerSec: 0
  };
  const lastSentArena = { x: 80, y: 85, btn: 0, sentAt: 0 };
  const remoteArena = {
    x: 240, y: 85, btn: 0, seq: 0, lastRxAt: 0, lastGapMs: 0,
    rxCountThisSec: 0, rxPerSec: 0, via: '--'
  };
  const keysHeld = new Set();
  let draggingArena = false;
  let lastArenaFrameTime = performance.now();

  function renderSuiteScorecard() {
    if (metrics.suiteResults.length === 0) return;
    els.suiteTableBody.innerHTML = '';
    for (const s of metrics.suiteResults) {
      const tr = document.createElement('tr');
      const cls =
        s.status === 'PASS' ? 'ok' : s.status === 'WARN' ? 'warn' : 'err';
      tr.innerHTML =
        `<td><strong>${s.stage}</strong></td>` +
        `<td>${s.proto}</td>` +
        `<td><span class="badge ${cls}">${s.status}</span></td>` +
        `<td>${s.detail}</td>`;
      els.suiteTableBody.appendChild(tr);
    }
  }

  async function runFullAutoDiagnosticSuite() {
    if (!ctx.isPeerConnected()) {
      logEvent(
        'Wait for 2nd PC to join the room before running the Auto Suite!',
        'warn'
      );
      return;
    }
    metrics.suiteResults = [];
    els.suiteStatusBadge.className = 'badge warn';
    els.suiteStatusBadge.textContent = 'RUNNING...';
    logEvent('=== STARTING 5-STAGE 2-PC AUTOMATED DIAGNOSTIC SUITE ===', 'ok');

    await new Promise((r) => setTimeout(r, 1200));
    const wssRtt = metrics.wssPeer.rtt;
    const httpRtt = metrics.httpPeer.rtt;
    const wssDetail = wssRtt !== null ? `${wssRtt}ms` : 'BLOCKED';
    const httpDetail = httpRtt !== null ? `${httpRtt}ms` : '--';
    metrics.suiteResults.push({
      stage: '1. Relay Ping (WSS / HTTPS)',
      proto: wssRtt !== null ? 'WSS + HTTPS' : 'HTTPS Tunnel',
      status: wssRtt !== null ? 'PASS' : httpRtt !== null ? 'WARN' : 'FAIL',
      detail: `WSS=${wssDetail}, HTTPS=${httpDetail}`
    });
    renderSuiteScorecard();

    const activeRelay = wssRtt !== null ? 'wss' : 'http';

    const xferSingle64 = await suitesMgr.runDataTransferTest(
      64, 'single', activeRelay
    );
    metrics.suiteResults.push({
      stage: '2. 64KB Single Frame',
      proto: activeRelay.toUpperCase(),
      status: xferSingle64.ok ? 'PASS' : 'FAIL',
      detail: xferSingle64.ok
        ? `${xferSingle64.ms}ms (${xferSingle64.kbps} KB/s)`
        : xferSingle64.status
    });
    renderSuiteScorecard();

    const xferChunked256 = await suitesMgr.runDataTransferTest(
      256, 'chunked', activeRelay
    );
    metrics.suiteResults.push({
      stage: '3. 256KB Chunked (16x16KB)',
      proto: activeRelay.toUpperCase(),
      status: xferChunked256.ok ? 'PASS' : 'FAIL',
      detail: xferChunked256.ok
        ? `${xferChunked256.ms}ms (${xferChunked256.kbps} KB/s) CRC OK`
        : xferChunked256.status
    });
    renderSuiteScorecard();

    await webrtcMgr.startWebRtc(true);
    await new Promise((r) => setTimeout(r, 3000));
    const dcFast = webrtcMgr.getDcFast();
    const rtcPeer = webrtcMgr.getRtcPeer();
    const p2pOpen = dcFast && dcFast.readyState === 'open';
    const iceLabel = rtcPeer ? rtcPeer.iceConnectionState : 'closed';
    metrics.suiteResults.push({
      stage: '4. WebRTC P2P Direct',
      proto: 'WebRTC UDP',
      status: p2pOpen ? 'PASS' : 'WARN',
      detail: p2pOpen
        ? `OPEN (RTT=${metrics.rtcFast.rtt ?? '--'}ms)`
        : `Blocked by NAT/ISP (${iceLabel}) — Using ` +
          `${activeRelay.toUpperCase()}`
    });
    renderSuiteScorecard();

    const bestStreamVia = p2pOpen ? 'rtc_fast' : activeRelay;
    const streamRes = await suitesMgr.run60HzStreamTest(bestStreamVia, 180);
    if (streamRes) {
      const lossPct = streamRes.lossPct;
      const maxGap = streamRes.gaps.max;
      const st =
        lossPct === 0 && maxGap < 150 ? 'PASS' : lossPct < 5 ? 'WARN' : 'FAIL';
      metrics.suiteResults.push({
        stage: '5. 60Hz Input Stream',
        proto: bestStreamVia.toUpperCase(),
        status: st,
        detail:
          `Rx=${streamRes.received}/${streamRes.total} (Loss ${lossPct}%), ` +
          `MaxGap=${maxGap}ms, Clump=${streamRes.gaps.clumpedPct}%`
      });
    } else {
      metrics.suiteResults.push({
        stage: '5. 60Hz Input Stream',
        proto: bestStreamVia.toUpperCase(),
        status: 'FAIL',
        detail: 'Stream summary timed out'
      });
    }
    renderSuiteScorecard();

    webrtcMgr.sendViaTransport('auto', {
      type: 'diag_suite_results',
      suiteResults: metrics.suiteResults
    });

    els.suiteStatusBadge.className = 'badge ok';
    els.suiteStatusBadge.textContent = 'COMPLETE';
    logEvent('=== 2-PC AUTOMATED DIAGNOSTIC SUITE COMPLETE ===', 'ok');
  }

  function handleArenaPacket(msg, viaSource) {
    const now = performance.now();
    if (remoteArena.lastRxAt > 0) {
      remoteArena.lastGapMs = Math.round(now - remoteArena.lastRxAt);
    }
    remoteArena.lastRxAt = now;
    remoteArena.rxCountThisSec++;
    remoteArena.x = msg.x;
    remoteArena.y = msg.y;
    remoteArena.btn = msg.btn || 0;
    remoteArena.seq = msg.seq || 0;
    remoteArena.via = viaSource.toUpperCase();
  }

  function updateArenaFromPointer(e) {
    const rect = els.arenaCanvas.getBoundingClientRect();
    localArena.x = Math.max(
      12, Math.min(308, Math.round(e.clientX - rect.left))
    );
    localArena.y = Math.max(
      12, Math.min(158, Math.round(e.clientY - rect.top))
    );
  }

  function bindArenaInputListeners() {
    window.addEventListener('keydown', (e) => {
      if (
        document.activeElement === els.nickInput ||
        document.activeElement === els.roomInput
      ) {
        return;
      }
      keysHeld.add(e.code);
    });
    window.addEventListener('keyup', (e) => { keysHeld.delete(e.code); });
    els.arenaCanvas.addEventListener('pointerdown', (e) => {
      draggingArena = true;
      localArena.btn |= 1;
      updateArenaFromPointer(e);
    });
    window.addEventListener('pointermove', (e) => {
      if (draggingArena) updateArenaFromPointer(e);
    });
    window.addEventListener('pointerup', () => {
      draggingArena = false;
      localArena.btn &= ~1;
    });

    setInterval(() => {
      remoteArena.rxPerSec = remoteArena.rxCountThisSec;
      remoteArena.rxCountThisSec = 0;
      localArena.txPerSec = localArena.txCountThisSec;
      localArena.txCountThisSec = 0;
      els.arenaRateVal.textContent =
        `Tx:${localArena.txPerSec} / Rx:${remoteArena.rxPerSec} pkt/s ` +
        `(${remoteArena.via}) | Gap:${remoteArena.lastGapMs}ms`;
    }, 1000);
  }

  function stepArena60Hz(now = performance.now()) {
    const dtMs = Math.min(50, Math.max(1, now - lastArenaFrameTime));
    lastArenaFrameTime = now;
    const speed = 3 * (dtMs / (1000 / 60));

    let btnMask = draggingArena ? 1 : 0;
    if (keysHeld.has('KeyW') || keysHeld.has('ArrowUp')) {
      localArena.y = Math.max(12, localArena.y - speed);
      btnMask |= 16;
    }
    if (keysHeld.has('KeyS') || keysHeld.has('ArrowDown')) {
      localArena.y = Math.min(158, localArena.y + speed);
      btnMask |= 32;
    }
    if (keysHeld.has('KeyA') || keysHeld.has('ArrowLeft')) {
      localArena.x = Math.max(12, localArena.x - speed);
      btnMask |= 64;
    }
    if (keysHeld.has('KeyD') || keysHeld.has('ArrowRight')) {
      localArena.x = Math.min(308, localArena.x + speed);
      btnMask |= 128;
    }
    if (
      keysHeld.has('KeyZ') ||
      keysHeld.has('KeyJ') ||
      keysHeld.has('Space')
    ) {
      btnMask |= 1;
    }
    if (keysHeld.has('KeyX') || keysHeld.has('KeyK')) btnMask |= 2;
    localArena.btn = btnMask;

    const roundedX = Math.round(localArena.x);
    const roundedY = Math.round(localArena.y);

    if (ctx.isPeerConnected()) {
      const changed =
        roundedX !== lastSentArena.x ||
        roundedY !== lastSentArena.y ||
        localArena.btn !== lastSentArena.btn;
      const sel = els.arenaTransportSelect.value;
      const dcFast = webrtcMgr.getDcFast();
      const dcRel = webrtcMgr.getDcReliable();
      const usingDirectRtc =
        (dcFast?.readyState === 'open' &&
          (sel === 'auto' || sel === 'rtc_fast')) ||
        (dcRel?.readyState === 'open' && sel === 'rtc_rel');
      const minIntervalMs = usingDirectRtc ? 16 : 33;
      const elapsedSinceSend = now - lastSentArena.sentAt;

      if (
        (changed && elapsedSinceSend >= minIntervalMs) ||
        elapsedSinceSend >= 1000
      ) {
        localArena.seq++;
        localArena.txCountThisSec++;
        lastSentArena.x = roundedX;
        lastSentArena.y = roundedY;
        lastSentArena.btn = localArena.btn;
        lastSentArena.sentAt = now;

        webrtcMgr.sendViaTransport(sel, {
          type: 'diag_arena_state',
          x: roundedX, y: roundedY, btn: localArena.btn, seq: localArena.seq
        });
      }
    }

    arenaCtx.fillStyle = '#07090e';
    arenaCtx.fillRect(0, 0, 320, 170);
    arenaCtx.strokeStyle = '#141926';
    arenaCtx.beginPath();
    for (let x = 40; x < 320; x += 40) {
      arenaCtx.moveTo(x, 0);
      arenaCtx.lineTo(x, 170);
    }
    for (let y = 40; y < 170; y += 40) {
      arenaCtx.moveTo(0, y);
      arenaCtx.lineTo(320, y);
    }
    arenaCtx.stroke();

    const localDraw = { x: roundedX, y: roundedY, btn: localArena.btn };
    const remoteDraw = {
      x: Math.round(remoteArena.x),
      y: Math.round(remoteArena.y),
      btn: remoteArena.btn
    };

    const isP1 = ctx.getLocalPlayerIndex() === 1;
    const p1 = isP1 ? localDraw : remoteDraw;
    const p2 = isP1 ? remoteDraw : localDraw;

    arenaCtx.fillStyle = '#f43f5e';
    arenaCtx.fillRect(p1.x - 10, p1.y - 10, 20, 20);
    if (p1.btn & 1) {
      arenaCtx.strokeStyle = '#fff';
      arenaCtx.strokeRect(p1.x - 13, p1.y - 13, 26, 26);
    }
    arenaCtx.fillStyle = '#fff';
    arenaCtx.font = '10px Consolas, monospace';
    arenaCtx.fillText('P1', p1.x - 6, p1.y + 4);

    arenaCtx.fillStyle = '#38bdf8';
    arenaCtx.fillRect(p2.x - 10, p2.y - 10, 20, 20);
    if (p2.btn & 1) {
      arenaCtx.strokeStyle = '#fff';
      arenaCtx.strokeRect(p2.x - 13, p2.y - 13, 26, 26);
    }
    arenaCtx.fillStyle = '#041019';
    arenaCtx.fillText('P2', p2.x - 6, p2.y + 4);

    const p1Hex = p1.btn.toString(16).padStart(2, '0');
    const p2Hex = p2.btn.toString(16).padStart(2, '0');
    els.p1PosVal.textContent = `x:${p1.x}, y:${p1.y} | btn:0x${p1Hex}`;
    els.p2PosVal.textContent = `x:${p2.x}, y:${p2.y} | btn:0x${p2Hex}`;

    requestAnimationFrame(stepArena60Hz);
  }

  return {
    renderSuiteScorecard,
    runFullAutoDiagnosticSuite,
    handleArenaPacket,
    startArenaLoop() {
      bindArenaInputListeners();
      requestAnimationFrame(stepArena60Hz);
    }
  };
}
