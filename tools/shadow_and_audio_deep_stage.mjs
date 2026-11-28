// Adversarial TDD Regressions: Shadow Watermark Catchup, NaN & Audio BootQueue
import assert from 'assert';
import { createAudioDrcEngine } from '../public/js/audio_drc.mjs';
import { createDrcAudioCore } from '../public/js/audio_worklet_processor.mjs';
import { RollbackNetplayEngine } from '../src/netplay_engine.mjs';
import { createShadowRollbackHost } from '../src/shadow_rollback_host.mjs';
import {
  createShadowWorkerController
} from '../src/shadow_rollback_worker_core.mjs';
import { applyShadowCatchupState } from '../src/shadow_rollback_apply.mjs';
import { sleep } from './browser_cdp_harness.mjs';

function createDeterministicMockArcadeCore() {
  let acc = 0x12345678, n = 0;
  const fb = new Uint32Array(16);
  return {
    systemId: 'arcade', width: 4, height: 4, opts: {},
    stepFrame(p1, p2) {
      acc = (Math.imul(acc, 31) + p1 * 17 + p2 * 29 + (++n)) >>> 0;
      fb[0] = acc;
    },
    getFrameBuffer: () => fb,
    computeHash: () => acc >>> 0,
    saveStateBytes() {
      const b = new Uint8Array(8), dv = new DataView(b.buffer);
      dv.setUint32(0, acc >>> 0, true);
      dv.setUint32(4, n >>> 0, true);
      return b;
    },
    loadStateBytes(b) {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      acc = dv.getUint32(0, true);
      n = dv.getUint32(4, true);
    }
  };
}

function testUndefinedUsedConfFrameNaNGuard() {
  const core = createDeterministicMockArcadeCore();
  const eng = new RollbackNetplayEngine(core, {
    localPlayer: 1, online: true, inputDelayFrames: 0
  });
  eng.receiveRemoteInputPacket({
    type: 'netplay_input', sessionId: eng.sessionId, player: 2,
    startFrame: 31, inputs: new Array(32).fill(0)
  });
  for (let i = 0; i < 32; i++) eng.stepNetplayFrame(0);
  eng.localHashes.set(30, 0x11111111);
  eng.localHashes.set(60, 0xdeadbeef);
  const stats = {
    shadowSwaps: 0, shadowDroppedStale: 0, maxGap: 0, totalGap: 0
  };
  const res = applyShadowCatchupState(eng, {
    frame: 32, fromFrame: 20, usedConfFrame: undefined,
    simP1: new Uint32Array(12), simP2: new Uint32Array(12),
    stateBuf: core.saveStateBytes().buffer, stateLen: 8
  }, stats, 0, 31);
  assert.strictEqual(res.applied, true, 'Catchup must apply');
  assert.strictEqual(eng.localHashes.get(30), 0x11111111, 'Keep conf hash');
  assert.strictEqual(eng.localHashes.has(60), false, 'NaN leaked stale hash');
}

async function testOrganicCatchupAtWorkerWatermark() {
  const cSh = createDeterministicMockArcadeCore();
  const cRef = createDeterministicMockArcadeCore();
  const inbox = [];
  const e1 = new RollbackNetplayEngine(cSh, {
    localPlayer: 1, online: true, inputDelayFrames: 0
  });
  const eRef = new RollbackNetplayEngine(cRef, {
    localPlayer: 1, online: false, inputDelayFrames: 0
  });
  let onMsg = null;
  const ctrl = createShadowWorkerController((m) => inbox.push(m), {
    coreFactory: async () => createDeterministicMockArcadeCore(),
    chunkFrames: 100
  });
  const host = createShadowRollbackHost(cSh, {
    transport: {
      onMessage: (fn) => { onMsg = fn; },
      postMessage: (m) => ctrl.handleMessage(m),
      terminate: () => {}
    }
  });
  const drain = () => { while (inbox.length) onMsg(inbox.shift()); };
  e1.attachShadowRollback(host);
  await sleep(10);
  drain();

  e1.receiveRemoteInputPacket({
    type: 'netplay_input', sessionId: e1.sessionId, player: 2,
    startFrame: 19, inputs: new Array(20).fill(0)
  });
  for (let f = 0; f < 32; f++) {
    e1.stepNetplayFrame(0);
    eRef.stepNetplayFrame(0, (f === 25 || f === 28) ? 1 : 0);
  }
  drain();

  // Packet 1 triggers catchup job1 (simulating f=28 as 0); before host drains
  // catchup_state, Packet 2 confirms frames 26..31 (f=28=1) so worker advances
  // confFrame to 32 (=== engine.currentFrame) and emits confirmed_progress(32).
  e1.receiveRemoteInputPacket({
    type: 'netplay_input', sessionId: e1.sessionId, player: 2,
    startFrame: 25, inputs: [1, 0, 0, 0, 0, 0]
  });
  const p2 = [];
  for (let f = 31; f >= 20; f--) p2.push((f === 25 || f === 28) ? 1 : 0);
  e1.receiveRemoteInputPacket({
    type: 'netplay_input', sessionId: e1.sessionId, player: 2,
    startFrame: 31, inputs: p2
  });
  drain();

  host.applyPendingAndRequestCatchup(e1);
  const fp = host.flush(e1, 500);
  drain();
  await fp;
  drain();
  host.applyPendingAndRequestCatchup(e1);

  assert.strictEqual(
    cSh.computeHash(), cRef.computeHash(),
    'Catchup dropped at workerConfirmedFrame === currentFrame!'
  );
  assert.strictEqual(e1.earliestMispredictedFrame, null);
  e1.destroy();
}

async function testSlowAddModuleBootQueueNoOverflow() {
  const prevAC = globalThis.AudioContext;
  const prevAWN = globalThis.AudioWorkletNode;
  const wc = createDrcAudioCore({ outSampleRate: 48000, mode: 'worklet' });
  let resolveAdd = null;
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage(m) {
          if (m?.type === 'chunk') wc.pushChunk(m.l, m.r, m.len);
        }
      };
    }
    connect() {}
  };
  globalThis.AudioContext = class {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = {};
      this.audioWorklet = {
        addModule: () => new Promise((r) => { resolveAdd = r; })
      };
    }
    resume() { return Promise.resolve(); }
  };
  try {
    const aEng = createAudioDrcEngine({});
    aEng.initAudio();
    for (let f = 0; f < 15; f++) {
      aEng.beginFrame();
      for (let i = 0; i < 800; i++) aEng.pushSample(0.2, -0.2);
      aEng.endFrame();
    }
    resolveAdd();
    await sleep(10);
    const st = wc.getStats();
    assert.strictEqual(st.overflows, 0, 'Slow addModule overflowed ring!');
    assert.ok(
      st.queued >= 2880 && st.queued <= 4096, `Bad queued=${st.queued}`
    );
  } finally {
    globalThis.AudioContext = prevAC;
    globalThis.AudioWorkletNode = prevAWN;
  }
}

export async function runShadowAndAudioDeepStage() {
  testUndefinedUsedConfFrameNaNGuard();
  await testOrganicCatchupAtWorkerWatermark();
  await testSlowAddModuleBootQueueNoOverflow();
  console.log(
    '[PASS] Deep-4: Shadow Empty-Slice Catchup, NaN Guard & BootQueue'
  );
}
