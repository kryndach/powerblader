// Reconnect/F5 Takeover, 48kHz Audio DRC Stress & Multi-Console Zero-GC Bench
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import WebSocket from 'ws';
import {
  NesNetplayEngine, INPUT_BITS, saveFastState, loadFastState
} from '../src/netplay_engine.mjs';
import { createCoopServer } from '../server/relay_server.mjs';
import { createAudioDrcEngine } from '../public/js/audio_drc.mjs';
import { handleRomTransferMessage } from '../public/js/rom_archive.mjs';

function httpRequest(urlStr, method = 'GET', bodyBuf = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, method, headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

export async function runTest5ReconnectAndZombieEviction() {
  const tmpSaves = path.join(
    (await import('os')).default.tmpdir(), `nes_saves_${Date.now()}`
  );
  const app = createCoopServer({ logAccess: false, savesDir: tmpSaves });
  const port = await app.listen(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  try {
    const ws1 = new WebSocket(wsUrl);
    const ws2 = new WebSocket(wsUrl);
    await Promise.all([
      new Promise((r) => ws1.once('open', r)),
      new Promise((r) => ws2.once('open', r))
    ]);

    ws1.send(JSON.stringify({
      type: 'join_room', roomCode: 'F5ROOM', clientId: 'cid_p1', nick: 'Host'
    }));
    await new Promise((r) => ws1.once('message', r));

    ws2.send(JSON.stringify({
      type: 'join_room', roomCode: 'F5ROOM', clientId: 'cid_p2', nick: 'Guest'
    }));
    await new Promise((r) => ws2.once('message', r));

    // Scenario A: P2 reconnects with same clientId BEFORE old ws2 TCP socket
    // closes; old ws2 closing afterwards must NOT evict the new ws2Re session!
    const ws2Re = new WebSocket(wsUrl);
    const reMsgs = [];
    await new Promise((r) => ws2Re.once('open', r));
    ws2Re.on('message', (d) => reMsgs.push(JSON.parse(d.toString())));
    ws2Re.send(JSON.stringify({
      type: 'join_room', roomCode: 'F5ROOM', clientId: 'cid_p2',
      nick: 'Guest', forceRoomJoined: true
    }));
    await new Promise((r) => setTimeout(r, 25));
    ws2.close();
    await new Promise((r) => setTimeout(r, 25));
    ws1.send(JSON.stringify({
      type: 'state_sync', frame: 120, sessionId: 's_120'
    }));
    await new Promise((r) => setTimeout(r, 30));

    const joinedA = reMsgs.find((m) => m.type === 'room_joined');
    const flushedSync = reMsgs.find((m) => m.type === 'state_sync');
    assert.strictEqual(joinedA?.playerIndex, 2);
    assert.strictEqual(flushedSync?.frame, 120);

    // Scenario B: P2 hits Browser F5 (old socket closes, brand-new clientId
    // joins). Server must evict closed zombie socket and assign Player 2.
    ws2Re.close();
    await new Promise((r) => setTimeout(r, 30));

    const ws2F5 = new WebSocket(wsUrl);
    await new Promise((r) => ws2F5.once('open', r));
    const f5JoinedPromise = new Promise((resolve) => {
      ws2F5.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'room_joined') resolve(msg);
      });
    });
    ws2F5.send(JSON.stringify({
      type: 'join_room', roomCode: 'F5ROOM',
      clientId: 'cid_p2_f5', nick: 'GuestF5'
    }));
    const joinedB = await f5JoinedPromise;
    assert.strictEqual(joinedB.playerIndex, 2);
    assert.strictEqual(joinedB.peers.length, 2);

    // Scenario C: Verify speed_ctrl forwarding for Online Turbo Fast-Forward
    const speedPromise = new Promise((resolve) => {
      ws2F5.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'speed_ctrl') resolve(msg);
      });
    });
    ws1.send(JSON.stringify({ type: 'speed_ctrl', speed: 4 }));
    const speedMsg = await speedPromise;
    assert.strictEqual(speedMsg.speed, 4);

    // Scenario D: Verify Gzip Room ROM HTTP Cache (CRC lookup) & Disk Save API
    const base = `http://127.0.0.1:${port}`;
    const fakeRom = Buffer.alloc(32768, 0x5a);
    const gzRom = zlib.gzipSync(fakeRom);
    const postRomRes = await httpRequest(
      `${base}/api/room-rom?room=F5ROOM&crc=DEADBEEF&name=Test.sfc`,
      'POST', gzRom, { 'X-Rom-Encoding': 'gzip' }
    );
    assert.strictEqual(postRomRes.status, 200);
    const getRomRes = await httpRequest(
      `${base}/api/room-rom?room=OTHER_ROOM&crc=DEADBEEF`
    );
    assert.strictEqual(getRomRes.status, 200);
    assert.strictEqual(getRomRes.body.length, 32768);
    assert.strictEqual(getRomRes.body[0], 0x5a);

    // Verify late rom_transfer_progress is ignored during active gameplay
    let bannerShown = false;
    const mockUi = {
      topSendRomBtn: { textContent: 'Send ROM' },
      showScreenBanner: () => { bannerShown = true; }
    };
    handleRomTransferMessage(
      { type: 'rom_transfer_progress', pct: 44 },
      {
        sendingRomSessionId: 's1',
        matchStarted: true,
        engine: { syncPaused: false }
      },
      mockUi
    );
    assert.strictEqual(bannerShown, false);
    assert.strictEqual(mockUi.topSendRomBtn.textContent, 'Send ROM');

    const savePayload = Buffer.from(JSON.stringify({
      romCrc32: 'TESTCRC1', slot: 1,
      entry: { frame: 300, syncState: { f: 300, rawStateB64: 'AA==' } }
    }));
    const postSave = await httpRequest(
      `${base}/api/save-slot`, 'POST', savePayload
    );
    assert.strictEqual(postSave.status, 200);
    const getSave = await httpRequest(
      `${base}/api/save-slot?crc=TESTCRC1&slot=1`
    );
    const gotSaveJson = JSON.parse(getSave.body.toString('utf8'));
    assert.strictEqual(gotSaveJson.ok, true);
    assert.strictEqual(gotSaveJson.entry.frame, 300);
    try { fs.rmSync(tmpSaves, { recursive: true, force: true }); } catch {}

    ws1.close();
    ws2F5.close();
    console.log(
      '[PASS] Edge Case 5: Mid-Match Reconnect, F5 Zombie Eviction, ' +
        'Turbo speed_ctrl, Room ROM HTTP Cache & Disk Save API Verified'
    );
  } finally {
    await app.close();
  }
}

export function runTest6AudioDrcAndDeclick() {
  let audioProcessCb = null;
  const origAudioCtx = globalThis.AudioContext;
  globalThis.AudioContext = class MockAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = {};
    }
    createScriptProcessor(bufSize) {
      const node = {
        bufSize, onaudioprocess: null,
        connect() { audioProcessCb = this.onaudioprocess; }
      };
      return node;
    }
  };

  try {
    const drc = createAudioDrcEngine({});
    drc.initAudio();
    assert.strictEqual(typeof audioProcessCb, 'function');

    const outL = new Float32Array(1024);
    const outR = new Float32Array(1024);
    const pullBlock = () => {
      audioProcessCb({
        outputBuffer: { getChannelData: (ch) => (ch === 0 ? outL : outR) }
      });
    };

    // 1. Pre-buffer silence (< 2800 samples) then smooth fade-in (>= 2800)
    for (let i = 0; i < 1000; i++) drc.pushSample(0.5, -0.5);
    pullBlock();
    assert.strictEqual(outL[512], 0);

    for (let i = 0; i < 2000; i++) drc.pushSample(0.5, -0.5);
    pullBlock();
    assert.ok(Math.abs(outL[0]) < Math.abs(outL[63]), '64-sample fade-in');

    // Verify steady 60Hz 48kHz streaming has 0 underruns and 0 overflows
    const u0 = drc.getStats().underruns;
    let clk = 0;
    for (let f = 0; f < 120; f++) {
      for (let i = 0; i < 800; i++) {
        const s = Math.sin((f * 800 + i) * 0.05) * 0.5;
        drc.pushSample(s, s);
      }
      clk += 800;
      while (clk >= 1024) { clk -= 1024; pullBlock(); }
    }
    assert.strictEqual(drc.getStats().underruns, u0, '60Hz audio underran!');

    // 2. Jittery network bursts + overflow clamp (> 6400 samples)
    for (let tick = 0; tick < 20; tick++) {
      const burst = tick % 3 === 0 ? 450 : tick === 10 ? 7000 : 1100;
      for (let i = 0; i < burst; i++) {
        const s = Math.sin((tick * 800 + i) * 0.05) * 0.6;
        drc.pushSample(s, s);
      }
      pullBlock();
      for (let i = 0; i < 1024; i++) {
        assert.ok(Number.isFinite(outL[i]) && Math.abs(outL[i]) <= 1.0);
      }
    }

    // 3. Verify 48-sample Rollback De-Click filter on waveform discontinuity
    const declickOut = [];
    const mockCore = {
      systemId: 'nes', width: 256, height: 240,
      opts: { onAudioSample: (l) => declickOut.push(l) },
      stepFrame(p1, p2, headless) {
        if (!headless) this.opts.onAudioSample(this.val, this.val);
      },
      saveStateInto(slot, f) { slot.frame = f; slot.v = this.val; },
      loadStateFromSlot(slot) { this.val = slot.v; return true; },
      getFrameBuffer: () => new Uint32Array(256 * 240),
      computeHash: () => 1, val: 0.65
    };
    const eng = new NesNetplayEngine(mockCore, {
      localPlayer: 1, online: true
    });
    eng.stepNetplayFrame(0);
    eng.stepNetplayFrame(0);
    const preJumpSample = declickOut[declickOut.length - 1];
    mockCore.val = -0.65;
    eng.receiveRemoteInputPacket({
      sessionId: eng.sessionId, startFrame: 0, inputs: [INPUT_BITS.A]
    });
    eng.stepNetplayFrame(0);
    const postRbFirstSample = declickOut[declickOut.length - 1];
    assert.ok(
      Math.abs(postRbFirstSample - preJumpSample) < 0.05,
      'Rollback de-click filter must smooth sudden +0.65 -> -0.65 jump'
    );
    console.log(
      '[PASS] Edge Case 6: 48kHz Audio DRC Resampler, Overflow Clamp & ' +
        '48-Sample Rollback De-Click Verified'
    );
  } finally {
    globalThis.AudioContext = origAudioCtx;
  }
}

export function benchmarkAndVerifyZeroGc(
  label, core, isNes = false, warmupFrames = 30
) {
  const eng = new NesNetplayEngine(core, { localPlayer: 1, online: true });
  const slot = eng.saveRing[0];
  for (let w = 0; w < warmupFrames; w++) eng.stepNetplayFrame(0);

  // Record pre-allocated buffer references in saveRing[0] & saveRing[2]
  const ref0 = isNes ? eng.saveRing[0].cpuMem : eng.saveRing[0].stateBytes;
  const ref2 = isNes ? eng.saveRing[2].cpuMem : eng.saveRing[2].stateBytes;
  assert.ok(ref0 && ref2, `${label} saveRing buffers should be allocated`);

  const N = 30;
  const v0 = performance.now();
  for (let i = 0; i < N; i++) {
    if (isNes) { core.ppu._headlessFrame = false; core.frame(); }
    else core.stepFrame(INPUT_BITS.RIGHT, 0, false);
  }
  const visMs = (performance.now() - v0) / N;

  const h0 = performance.now();
  for (let i = 0; i < N; i++) {
    if (isNes) {
      core.ppu._headlessFrame = true;
      core.frame();
      core.ppu._headlessFrame = false;
    } else core.stepFrame(INPUT_BITS.RIGHT, 0, true);
  }
  const headMs = (performance.now() - h0) / N;

  let tSave = 0, tLoad = 0;
  for (let i = 0; i < 10; i++) {
    if (isNes) { core.ppu._headlessFrame = true; core.frame(); }
    else core.stepFrame(0, 0, true);
    const s0 = performance.now();
    if (isNes) saveFastState(core, slot, i);
    else core.saveStateInto(slot, i);
    tSave += performance.now() - s0;

    const l0 = performance.now();
    if (isNes) loadFastState(core, slot);
    else core.loadStateFromSlot(slot);
    tLoad += performance.now() - l0;
  }

  // Run 65 more frames to wrap saveRing and verify Zero-GC buffer identity
  for (let f = 0; f < 65; f++) eng.stepNetplayFrame(f & 1);
  const after0 = isNes ? eng.saveRing[0].cpuMem : eng.saveRing[0].stateBytes;
  const after2 = isNes ? eng.saveRing[2].cpuMem : eng.saveRing[2].stateBytes;
  assert.strictEqual(after0, ref0, `${label} reallocated saveRing[0]!`);
  assert.strictEqual(after2, ref2, `${label} reallocated saveRing[2]!`);

  const saveMs = tSave / 10, loadMs = tLoad / 10;
  const rb5Ms = loadMs + 4 * headMs + saveMs + visMs;
  const rb10Ms = loadMs + 9 * headMs + 2 * saveMs + visMs;
  const nesBytes = isNes
    ? (slot.cpuMem?.byteLength || 0) + (slot.vramMem?.byteLength || 0) +
      (slot.spriteMem?.byteLength || 0) + ((slot.ppuScalars?.length || 0) * 8)
    : 0;
  const stateKb = (isNes
    ? nesBytes : (slot.usedLen || slot.stateBytes?.length || 0)) / 1024;
  console.log(
    `[BENCH+0GC] ${label.padEnd(20)} | Vis=${visMs.toFixed(2)}ms | ` +
      `Head=${headMs.toFixed(2)}ms | Save=${saveMs.toFixed(2)}ms ` +
      `(${stateKb.toFixed(0)}KB) | Load=${loadMs.toFixed(2)}ms | ` +
      `5f-RB=${rb5Ms.toFixed(2)}ms | 10f-RB=${rb10Ms.toFixed(2)}ms`
  );
  assert.ok(visMs + saveMs < 16.67 && saveMs + loadMs < visMs * 2.5);
}
