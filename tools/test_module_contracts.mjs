// Isolated SOLID Module Contract Tests (Store, Router, Rollback, WASM, Relay)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createConsoleState, resetPingWindow, resetPeerSessionState,
  clearActiveRomTransfers
} from '../public/js/session_store.mjs';
import { createInputRouter } from '../public/js/input_router.mjs';
import { computeRecommendedInputDelay } from '../src/netplay_rollback.mjs';
import {
  RGB565_TO_BGR24, listZipEntryNames, createMinimalArcadeTestZip
} from '../src/wasm_runtime_loader.mjs';
import {
  handleAutotestReportWs, handleGameplayTelemetryWs
} from '../server/telemetry_relay_handlers.mjs';
import {
  isCpuInTightWaitLoop, setNesOverclockEnabled
} from '../src/ppu_sprite_and_overclock.mjs';
import { extractRomFromFile } from '../server/archive_extractor.mjs';

function testSessionStoreContracts() {
  const st = createConsoleState();
  let aborted = false, resetCalled = false;
  st.peerConnected = true;
  st.partnerRomCrc32 = 'ABCD1234';
  st.matchStarted = true;
  st.rttMs = 240;
  st._rttSamples = [230, 240, 250];
  st.activeRomAbortCtrl = { abort: () => { aborted = true; } };
  const ui = { resetSendRomButtons: () => { resetCalled = true; } };

  clearActiveRomTransfers(st, ui);
  assert.strictEqual(aborted, true);
  assert.strictEqual(resetCalled, true);
  assert.strictEqual(st.activeRomAbortCtrl, null);

  resetPingWindow(st);
  assert.strictEqual(st.rttMs, 0);
  assert.deepStrictEqual(st._rttSamples, []);

  st.peerConnected = true;
  st.rttMs = 199;
  resetPeerSessionState(st, ui);
  assert.strictEqual(st.peerConnected, false);
  assert.strictEqual(st.partnerRomCrc32, null);
  assert.strictEqual(st.matchStarted, false);
  assert.strictEqual(st.rttMs, 0);
}

function testInputRouterDeduplicationContract() {
  let delivered = 0;
  const st = createConsoleState();
  st.peerConnected = true;
  st.engine = { receiveRemoteInputPacket: () => { delivered++; } };
  const router = createInputRouter(st);

  const pktA = { sessionId: 's', startFrame: 10, inputs: [3] };
  const pktB = { sessionId: 's', startFrame: 11, inputs: [2] };
  assert.strictEqual(router.routeNetplayInput(pktA), true);
  assert.strictEqual(router.routeNetplayInput(pktB), true);
  assert.strictEqual(router.routeNetplayInput(pktA), false);
  assert.strictEqual(router.routeNetplayInput(pktB), false);
  assert.strictEqual(delivered, 2);
  assert.strictEqual(st.rxCountThisSec, 2);

  // Overflow 128-key FIFO cap cleanly without unbounded memory growth
  for (let f = 100; f < 300; f++) {
    router.routeNetplayInput({ sessionId: 's', startFrame: f, inputs: [1] });
  }
  assert.ok(st.rxInputDedupSet.size <= 128);
}

function testRollbackDelayHysteresisAndWasmHelpers() {
  assert.strictEqual(computeRecommendedInputDelay(50, 5, 0, null), 2);
  assert.strictEqual(computeRecommendedInputDelay(120, 5, 0, null), 3);
  assert.strictEqual(computeRecommendedInputDelay(230, 10, 1, null), 4);
  assert.strictEqual(computeRecommendedInputDelay(350, 20, 2, null), 5);
  // Hysteresis prevents jittering from 4 -> 5 at boundary 315ms
  assert.strictEqual(computeRecommendedInputDelay(315, 0, 0, 4), 4);

  assert.strictEqual(RGB565_TO_BGR24[0xf800], 0x0000ff); // Pure red RGB565
  assert.strictEqual(RGB565_TO_BGR24[0x001f], 0xff0000); // Pure blue RGB565
  const miniZip = createMinimalArcadeTestZip();
  assert.deepStrictEqual(listZipEntryNames(miniZip), ['d26-01.ic7']);

  // Verify split arcade clone ZIP (tgm2p.zip) auto-merges sibling parent ZIP
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes_arc_merge_'));
  try {
    const parentZip = Buffer.from(miniZip);
    // Build a 1-entry child ZIP with a different filename ("1b.u22")
    const childZip = Buffer.from(miniZip);
    const nameOff = childZip.indexOf(Buffer.from('d26-01.ic7'));
    childZip.write('1b.u22    ', nameOff, 10, 'utf8');
    const cdOff = childZip.lastIndexOf(Buffer.from('d26-01.ic7'));
    childZip.write('1b.u22    ', cdOff, 10, 'utf8');
    fs.writeFileSync(path.join(tmp, 'tgm2.zip'), parentZip);
    const childPath = path.join(tmp, 'tgm2p.zip');
    fs.writeFileSync(childPath, childZip);
    const merged = extractRomFromFile(childPath);
    const names = listZipEntryNames(new Uint8Array(merged.romBuffer));
    assert.ok(names.includes('d26-01.ic7'), 'Parent ZIP entry missing!');
    assert.ok(names.some((n) => n.startsWith('1b.u22')), 'Child entry missing');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testServerTelemetryRelayHandlers() {
  let savedAuto = 0, savedTel = 0, sent = [], bcast = [];
  const trackers = {
    autotestSession: { pc1: null, pc2: null, combinedText: 'REPORT_OK' },
    gameplayTelemetrySession: { pc1: null, pc2: null },
    saveAutotestReportToDisk: () => { savedAuto++; },
    saveGameplayTelemetryToDisk: () => { savedTel++; }
  };
  const peer = { roomCode: 'NOVA', clientId: 'c1', playerIndex: 1 };
  handleAutotestReportWs(
    peer, { report: { playerIndex: 2, isFinal: true } }, trackers,
    { logAccess: false }, (p, m) => sent.push(m), (_r, _c, m) => bcast.push(m)
  );
  assert.strictEqual(savedAuto, 1);
  assert.strictEqual(trackers.autotestSession.pc2.isFinal, true);
  assert.strictEqual(sent[0].combinedText, 'REPORT_OK');
  assert.strictEqual(bcast[0].combinedText, 'REPORT_OK');

  handleGameplayTelemetryWs(
    peer, { telemetry: { playerIndex: 1, rttMs: 215 } }, trackers
  );
  assert.strictEqual(savedTel, 1);
  assert.strictEqual(trackers.gameplayTelemetrySession.pc1.rttMs, 215);
}

function testOverclockWaitLoopContract() {
  const mkCpu = (pc, bytes, sp = 0xfa) => {
    const mem = new Uint8Array(0x10000);
    for (let i = 0; i < bytes.length; i++) mem[(pc + i) & 0xffff] = bytes[i];
    return { REG_PC: (pc - 1) & 0xffff, REG_SP: sp, mem };
  };
  const wait = (pc, bytes) => isCpuInTightWaitLoop(mkCpu(pc, bytes));
  // True wait loops: JMP self, LDA zp + BNE -4, BIT abs + BPL -5
  assert.strictEqual(wait(0x8057, [0x4c, 0x57, 0x80]), true);
  assert.strictEqual(wait(0xc1ed, [0xa5, 0x2f, 0xd0, 0xfc]), true);
  assert.strictEqual(wait(0x8000, [0x2c, 0x02, 0x20, 0x10, 0xfb]), true);
  // False positives rejected: Battletoads SBC $52; BCS -4 and DEC $10; BNE -4
  assert.strictEqual(wait(0x8c09, [0xe5, 0x52, 0xb0, 0xfc]), false);
  assert.strictEqual(wait(0x8c0b, [0xb0, 0xfc]), false);
  assert.strictEqual(wait(0x9000, [0xc6, 0x10, 0xd0, 0xfc]), false);

  const mock = { ppu: { _overclockEnabled: false, _hasTightWaitLoop: true } };
  assert.strictEqual(setNesOverclockEnabled(mock, true), true);
  assert.strictEqual(mock.ppu._overclockEnabled, true);
  assert.strictEqual(setNesOverclockEnabled(mock, false), false);
  assert.strictEqual(mock.ppu._hasTightWaitLoop, false);
}

export function runModuleContractSuite() {
  console.log('=== SOLID Module Contract Test Suite ===\n');
  testSessionStoreContracts();
  testInputRouterDeduplicationContract();
  testRollbackDelayHysteresisAndWasmHelpers();
  testServerTelemetryRelayHandlers();
  testOverclockWaitLoopContract();
  console.log(
    '[PASS] SessionStore, InputRouter, RollbackPolicy, OverclockWait, ' +
      'WasmLoader & TelemetryRelay Contracts Verified'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)) {
  runModuleContractSuite();
}
