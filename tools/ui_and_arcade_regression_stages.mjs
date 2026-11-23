// Mid-Game Lobby Popup State-Machine Guard & High-RTT Arcade/SNES Rollback QA
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { NesNetplayEngine, INPUT_BITS } from '../src/netplay_engine.mjs';
import { createFbneoArcadeCore } from '../src/fbneo_arcade_core.mjs';
import { createSnes9xCore } from '../src/sega_gpgx_core.mjs';
import { extractRomFromFile } from '../server/archive_extractor.mjs';
import {
  runTest11SmoothnessDedupAndUploadResilience
} from './smoothness_and_upload_regression_stage.mjs';
import { createConsoleUI } from '../public/js/console_ui.mjs';
import { formatTransferProgress } from '../public/js/transfer_status_ui.mjs';
import { createRomSyncManager } from '../public/js/rom_sync.mjs';
import { createProtocolHandlers } from '../public/js/net_protocol_handlers.mjs';
import { createTelemetryReporter } from '../public/js/telemetry_reporter.mjs';

function createMockElement(id = '') {
  const classes = new Set(id === 'lobbyOverlay' ? [] : []);
  return {
    id, value: id === 'topInputDelaySelect' || id === 'inputDelaySelect'
      ? '2' : '',
    textContent: '', innerHTML: '', disabled: false, style: {}, children: [],
    width: 256, height: 240, dataset: { bit: '1' },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c); else classes.delete(c);
      }
    },
    get className() { return [...classes].join(' '); },
    set className(v) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((x) => classes.add(x));
    },
    prepend(el) { this.children.unshift(el); },
    appendChild(el) { this.children.push(el); },
    removeChild(el) {
      const i = this.children.indexOf(el);
      if (i >= 0) this.children.splice(i, 1);
    },
    get lastChild() { return this.children[this.children.length - 1]; },
    get options() { return this.children; },
    querySelector: () => ({ textContent: '' }),
    querySelectorAll: () => [],
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {}
    })
  };
}

function verifyTransferProgressUiSurfaces(state, ui, proto) {
  const detail = formatTransferProgress({
    pct: 1, loadedBytes: 16384, totalBytes: 20971520, bps: 358400
  });
  ui.setTransferStatus({
    phase: 'uploading', romName: 'tgm2p.zip', pct: 1, detail
  });
  assert.strictEqual(ui.topSendRomBtn.textContent, 'Uploading 1%');
  assert.strictEqual(ui.topSendRomBtn.disabled, true);
  assert.strictEqual(ui.sendRomManualBtn.textContent, 'Uploading ROM (1%)...');
  assert.strictEqual(ui.sendRomManualBtn.disabled, true);
  assert.ok(ui.lobbyFooterText.innerHTML.includes('xfer-box'));
  assert.ok(ui.lobbyFooterText.innerHTML.includes('width:1%'));
  assert.ok(ui.lobbyFooterText.innerHTML.includes('350 KB/s'));
  assert.ok(!ui.lobbyFooterText.innerHTML.includes('Different'));
  assert.strictEqual(ui.lobbyP1Badge.textContent, 'UPLOAD 1%');
  assert.ok(ui.statusText.textContent.includes('Uploading "tgm2p.zip"'));
  assert.strictEqual(ui.screenBanner.classList.contains('visible'), true);

  state.sendingRomSessionId = 'S_XFER';
  proto.handleIncomingNetMessage({
    type: 'rom_transfer_progress', stage: 'downloading',
    pct: 1, loadedBytes: 65536, totalBytes: 20971520, bps: 409600
  });
  assert.strictEqual(ui.topSendRomBtn.textContent, 'Sending 1%');
  assert.strictEqual(ui.topSendRomBtn.disabled, true);
  assert.strictEqual(
    ui.sendRomManualBtn.textContent, 'Sending to Partner (1%)...'
  );
  assert.strictEqual(ui.lobbyP2Badge.textContent, 'DL 1%');

  proto.handleIncomingNetMessage({
    type: 'rom_transfer_progress', stage: 'loading-core', pct: 35
  });
  assert.strictEqual(ui.topSendRomBtn.textContent, 'Starting...');
  assert.strictEqual(ui.topSendRomBtn.disabled, true);
  assert.strictEqual(ui.lobbyP2Badge.textContent, 'STARTING 35%');

  state.partnerRomCrc32 = state.romCrc32;
  proto.handleIncomingNetMessage({
    type: 'sync_ack', sessionId: state.engine.sessionId, romCrc32: '60C4E9CB'
  });
  assert.strictEqual(state.transferStatus, null);
  assert.strictEqual(ui.topSendRomBtn.textContent, 'Send ROM');
  assert.strictEqual(ui.topSendRomBtn.disabled, false);
  assert.strictEqual(ui.sendRomManualBtn.textContent, 'Send ROM to Partner');
  assert.strictEqual(ui.sendRomManualBtn.disabled, false);
  assert.strictEqual(ui.lobbyOverlay.classList.contains('hidden'), true);

  ui.setTransferStatus({ phase: 'sending', romName: 'tgm2p.zip', pct: 42 });
  proto.handleIncomingNetMessage({ type: 'peer_left' });
  assert.strictEqual(state.transferStatus, null);
  assert.strictEqual(ui.topSendRomBtn.disabled, false);
}

export function runTest8MidGameLobbyPopupAndDelayGuard() {
  const origDoc = globalThis.document, origWin = globalThis.window;
  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) els.set(id, createMockElement(id));
    return els.get(id);
  };
  globalThis.document = {
    hidden: false,
    getElementById: getEl,
    createElement: (tag) => createMockElement(tag)
  };
  globalThis.window = { jsnes: null };

  try {
    const sent = [];
    const mockCore = {
      systemId: 'arcade', width: 320, height: 240, opts: {},
      loadROM: () => {}, stepFrame: () => {},
      saveStateInto: (s, f) => {
        s.frame = f;
        s.stateBytes = new Uint8Array(8);
      },
      loadStateFromSlot: () => true,
      saveStateBytes: () => new Uint8Array(8),
      loadStateBytes: () => {},
      getFrameBuffer: () => new Uint32Array(320 * 240),
      computeHash: () => 0x12345678
    };
    const state = {
      ws: { readyState: 1, send: (m) => sent.push(JSON.parse(m)) },
      roomCode: 'NOVA', localPlayerIndex: 1, peerConnected: true,
      peerNick: 'Partner', romName: 'tgm2p.zip', romCrc32: '60C4E9CB',
      partnerRomName: 'tgm2p.zip', partnerRomCrc32: '60C4E9CB',
      romUint8: new Uint8Array(16), romBinaryString: 'BINARY_ROM',
      nes: mockCore, engine: null, matchStarted: false,
      rttMs: 246, jitterMs: 13, customRomsMap: new Map(),
      telemetryEvents: [], telemetrySamples: [], lastAutoResyncTime: 0
    };
    state.engine = new NesNetplayEngine(mockCore, {
      localPlayer: 1, online: true, inputDelayFrames: 5
    });
    const ui = createConsoleUI(state);
    const romSync = createRomSyncManager(state, ui, { pushSample: () => {} });
    const telemetry = createTelemetryReporter(state, ui, romSync);
    const proto = createProtocolHandlers(
      state, ui, romSync,
      { connectAuxWebSocket: () => {}, startWebRtcSession: () => {},
        closeWebRtc: () => {}, handleWebRtcSignal: () => {} },
      telemetry
    );

    // 1. High-RTT (246ms) Arcade input delay defaults to 5f (prevents >3f RB)
    assert.strictEqual(romSync.resolveDesiredInputDelay('arcade'), 5);

    // 2. Before match starts, Lobby overlay is visible
    ui.updateLobbyOverlay();
    assert.strictEqual(ui.lobbyOverlay.classList.contains('hidden'), false);

    // 3. Match starts via match_start_ack -> Lobby overlay hides
    proto.handleIncomingNetMessage({
      type: 'match_start_ack', sessionId: state.engine.sessionId,
      romCrc32: '60C4E9CB'
    });
    assert.strictEqual(state.matchStarted, true);
    assert.strictEqual(ui.lobbyOverlay.classList.contains('hidden'), true);

    // 4. Mid-game state sync (Quick-Load F8 / Resync) sets syncPaused=true;
    //    Lobby / Load-ROM popup MUST stay hidden!
    romSync.sendStateSyncToPeer({ resetToZero: false });
    assert.strictEqual(state.engine.syncPaused, true);
    assert.strictEqual(
      ui.lobbyOverlay.classList.contains('hidden'), true,
      'Lobby / Load-ROM popup must NEVER appear during mid-game state sync!'
    );

    // 5. Mid-game Reset with matching ROM CRC keeps Lobby popup hidden
    romSync.startLockstepMatchAtFrameZero('Reset Button Clicked', true);
    assert.strictEqual(
      ui.lobbyOverlay.classList.contains('hidden'), true,
      'Lobby popup must stay hidden during mid-game Frame #0 reset!'
    );
    proto.handleIncomingNetMessage({
      type: 'match_start_ack', sessionId: state.engine.sessionId
    });

    // 6. Duplicate rom_status with SAME CRC32 during active gameplay is a no-op
    proto.handleIncomingNetMessage({
      type: 'rom_status', romCrc32: '60C4E9CB', romName: 'tgm2p.zip'
    });
    assert.strictEqual(state.matchStarted, true);
    assert.strictEqual(state.engine.syncPaused, false);
    assert.strictEqual(ui.lobbyOverlay.classList.contains('hidden'), true);

    // 7. Partner switches to a DIFFERENT ROM -> match stops & Lobby shows
    proto.handleIncomingNetMessage({
      type: 'rom_status', romCrc32: 'F8E0BC9B', romName: 'Power Blade 2.nes'
    });
    assert.strictEqual(state.matchStarted, false);
    assert.strictEqual(ui.lobbyOverlay.classList.contains('hidden'), false);
    verifyTransferProgressUiSurfaces(state, ui, proto);
    if (state.syncAckTimeout) clearTimeout(state.syncAckTimeout);

    console.log(
      '[PASS] Edge Case 7: Mid-Game Lobby Popup Guard, Live 1% Transfer UI & ' +
        'High-RTT Arcade 5f Auto-Delay Verified'
    );
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
}

async function runJitterySgRuRollbackSim(c1, c2, frames, delay1, delay2) {
  const e1 = new NesNetplayEngine(c1, {
    localPlayer: 1, online: true, inputDelayFrames: delay1
  });
  const e2 = new NesNetplayEngine(c2, {
    localPlayer: 2, online: true, inputDelayFrames: delay2
  });
  const q12 = [], q21 = [], stepTimes = [];
  for (let f = 0; f < frames; f++) {
    while (q12.length && q12[0].d <= f) {
      e2.receiveRemoteInputPacket(q12.shift().p);
    }
    while (q21.length && q21[0].d <= f) {
      e1.receiveRemoteInputPacket(q21.shift().p);
    }
    // Deliberately flip buttons right before f%30===0 hash boundaries (28,58..)
    const boundaryFlip = (f % 30 >= 26 && f % 30 <= 29);
    const m1 = boundaryFlip
      ? INPUT_BITS.A | INPUT_BITS.LEFT
      : (f === 65 ? INPUT_BITS.SELECT : f === 95 ? INPUT_BITS.START : 0);
    const m2 = boundaryFlip
      ? INPUT_BITS.B | INPUT_BITS.RIGHT
      : (f === 70 ? INPUT_BITS.SELECT : f === 100 ? INPUT_BITS.START : 0);

    const t0 = performance.now();
    const r1 = e1.stepNetplayFrame(m1);
    if (f >= 45) stepTimes.push(performance.now() - t0);
    const r2 = e2.stepNetplayFrame(m2);

    const jit1 = 7 + (f % 3 === 0 ? 1 : 0);
    const jit2 = 7 + (f % 4 === 0 ? 1 : 0);
    if (r1.packetToSend) q12.push({ d: f + jit1, p: r1.packetToSend });
    if (r2.packetToSend) q21.push({ d: f + jit2, p: r2.packetToSend });
  }
  while (q12.length) e2.receiveRemoteInputPacket(q12.shift().p);
  while (q21.length) e1.receiveRemoteInputPacket(q21.shift().p);
  for (let s = 0; s < 4; s++) {
    const a = e1.stepNetplayFrame(0), b = e2.stepNetplayFrame(0);
    if (a.packetToSend) e2.receiveRemoteInputPacket(a.packetToSend);
    if (b.packetToSend) e1.receiveRemoteInputPacket(b.packetToSend);
  }
  stepTimes.sort((a, b) => a - b);
  const p95 = stepTimes[Math.floor(stepTimes.length * 0.95)] || 0;
  return { e1, e2, p95 };
}

export async function runTest9RealArcadeAndSnesSgRuRollback(localDir, minZip) {
  const tgmPath = path.join(localDir, 'arcade', 'tgm2p.zip');
  let arcBytes = minZip, arcName = 'minivadr.zip';
  if (fs.existsSync(tgmPath)) {
    const ext = extractRomFromFile(tgmPath);
    arcBytes = new Uint8Array(ext.romBuffer);
    arcName = ext.romName;
  }
  const arcOpts = { romBytes: arcBytes, romName: arcName };
  const a1 = await createFbneoArcadeCore(arcOpts);
  let a2 = await createFbneoArcadeCore(arcOpts);
  let arcRes = await runJitterySgRuRollbackSim(a1, a2, 190, 5, 5);
  const rb = arcRes.e1.rollbacksTotal, p95Val = arcRes.p95;
  assert.ok(rb >= 8, 'Expected high-RTT rollbacks');
  assert.ok(arcRes.e1.lastVerifiedFrame >= 180, 'Expected >=6 hash checks');
  assert.strictEqual(arcRes.e1.desyncCount, 0, 'Arcade P1 must have 0 desyncs');
  assert.strictEqual(arcRes.e2.desyncCount, 0, 'Arcade P2 must have 0 desyncs');
  assert.strictEqual(a1.computeHash(), a2.computeHash());
  assert.ok(p95Val < 45, `Arcade p95 (${p95Val.toFixed(1)}ms) > 45ms`);
  a2 = null;
  arcRes = null;

  const snesDir = path.join(localDir, 'snes');
  let snesLabel = 'Skipped', snesRealCore = null;
  if (fs.existsSync(snesDir) && fs.readdirSync(snesDir).length > 0) {
    const sf = fs.readdirSync(snesDir).find((f) => f.endsWith('.zip'));
    if (sf) {
      const { romName, romBuffer } = extractRomFromFile(path.join(snesDir, sf));
      const u8 = new Uint8Array(romBuffer);
      const s1 = await createSnes9xCore({ romBytes: u8, romName });
      const s2 = await createSnes9xCore({ romBytes: u8, romName });
      const sRes = await runJitterySgRuRollbackSim(s1, s2, 130, 3, 2);
      assert.strictEqual(sRes.e1.desyncCount + sRes.e2.desyncCount, 0);
      assert.strictEqual(s1.computeHash(), s2.computeHash());
      snesLabel = `${romName} (p95=${sRes.p95.toFixed(2)}ms)`;
      snesRealCore = s1;
    }
  }
  const p95Str = p95Val.toFixed(2);
  console.log(
    `[PASS] Edge Case 8: High-RTT 240ms Boundary Rollback -> ${arcName} ` +
      `(RB=${rb}, 0 Desyncs, p95=${p95Str}ms) & SNES ${snesLabel}`
  );
  await runTest11SmoothnessDedupAndUploadResilience(localDir);
  return { arcCore: a1, snesRealCore };
}
