// Isolated SOLID Module Contract Tests (Store, Router, Rollback, WASM, Relay)
import assert from 'assert';
import { fileURLToPath } from 'url';
import path from 'path';
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

export function runModuleContractSuite() {
  console.log('=== SOLID Module Contract Test Suite ===\n');
  testSessionStoreContracts();
  testInputRouterDeduplicationContract();
  testRollbackDelayHysteresisAndWasmHelpers();
  testServerTelemetryRelayHandlers();
  console.log(
    '[PASS] SessionStore, InputRouter, RollbackPolicy, WasmLoader & ' +
      'TelemetryRelay Contracts Verified'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)) {
  runModuleContractSuite();
}
