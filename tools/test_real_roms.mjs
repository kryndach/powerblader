import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as jsnesModule from 'jsnes';
import WebSocket from 'ws';
import {
  NesNetplayEngine,
  INPUT_BITS,
  computeDeterministicHash,
  computeRomCrc32,
  formatHex32,
  saveFastState,
  loadFastState
} from '../src/netplay_engine.mjs';
import { createCoopServer } from '../server/relay_server.mjs';

const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_ROMS_DIR = path.resolve(__dirname, '..', 'local');

function inspectInesHeader(u8) {
  const prgKB = (u8[4] || 0) * 16;
  const chrKB = (u8[5] || 0) * 8;
  const mapper = ((u8[6] || 0) >> 4) | ((u8[7] || 0) & 0xf0);
  return { prgKB, chrKB, mapper, hasChrRam: chrKB === 0 };
}

async function runRealRomsSuite() {
  console.log('=== Real NES ROMs & Non-NES Netcode Optimization Test Suite ===\n');

  assert.ok(fs.existsSync(LOCAL_ROMS_DIR), `Expected local ROMs directory at ${LOCAL_ROMS_DIR}`);
  const romFiles = fs
    .readdirSync(LOCAL_ROMS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.nes'))
    .sort();
  assert.ok(
    romFiles.length >= 3,
    `Expected at least 3 .nes ROMs in local/, found ${romFiles.length}: ${romFiles.join(', ')}`
  );

  // Stage 1: Verify O(1) Headless PPU Bit-Exactness, Savestate Round-Trip & Frame Speed on All Real ROMs
  for (const fileName of romFiles) {
    const fullPath = path.join(LOCAL_ROMS_DIR, fileName);
    const buf = fs.readFileSync(fullPath);
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const crc = computeRomCrc32(u8);
    const hdr = inspectInesHeader(u8);
    const bin = buf.toString('binary');

    const nesNormal = new jsnes.NES({});
    const nesHeadless = new jsnes.NES({});
    nesNormal.loadROM(bin);
    nesHeadless.loadROM(bin);

    const engNormal = new NesNetplayEngine(nesNormal, { localPlayer: 1, online: true });
    const engHeadless = new NesNetplayEngine(nesHeadless, { localPlayer: 1, online: true });

    let normalMs = 0;
    let headlessMs = 0;
    for (let f = 0; f < 360; f++) {
      const p1 =
        (f % 45 === 10 ? INPUT_BITS.START : 0) |
        (f > 120 && (f >> 3) % 2 === 0 ? INPUT_BITS.RIGHT | INPUT_BITS.A : 0);
      const p2 =
        (f % 45 === 25 ? INPUT_BITS.START : 0) |
        (f > 120 && (f >> 3) % 2 === 1 ? INPUT_BITS.LEFT | INPUT_BITS.B : 0);

      // Save & restore mid-run at frame 180 to verify fast binary savestate fidelity on this real ROM
      if (f === 180) {
        const slot = engNormal.saveRing[0];
        saveFastState(nesNormal, slot, 180);
        // Advance 5 throwaway frames with random inputs, then restore slot and continue
        for (let k = 0; k < 5; k++) {
          nesNormal.frame();
        }
        loadFastState(nesNormal, slot);
      }

      const t0 = performance.now();
      nesNormal.ppu._headlessFrame = false;
      engNormal.stepNetplayFrame(p1, p2);
      normalMs += performance.now() - t0;

      const t1 = performance.now();
      nesHeadless.ppu._headlessFrame = true;
      engHeadless.stepNetplayFrame(p1, p2);
      nesHeadless.ppu._headlessFrame = false;
      headlessMs += performance.now() - t1;
    }

    const hashNormal = formatHex32(computeDeterministicHash(nesNormal));
    const hashHeadless = formatHex32(computeDeterministicHash(nesHeadless));
    assert.strictEqual(
      hashHeadless,
      hashNormal,
      `Headless PPU state hash mismatch on ${fileName}: ${hashHeadless} vs ${hashNormal}`
    );
    const avgNormalMs = normalMs / 360;
    const avgHeadlessMs = headlessMs / 360;
    assert.ok(
      avgNormalMs < 5.0,
      `Expected average frame time < 5.0ms on ${fileName}, got ${avgNormalMs.toFixed(2)}ms`
    );

    console.log(
      `[PASS] Stage 1 (${fileName}): CRC=${crc} Mapper=${hdr.mapper} CHR-RAM=${hdr.hasChrRam} | ` +
        `Normal=${avgNormalMs.toFixed(2)}ms/f, Headless=${avgHeadlessMs.toFixed(2)}ms/f | Hash=${hashNormal}`
    );
  }

  // Stage 2: Pinggy 250ms + Asymmetric TCP Clumping 2-PC Rollback Torture Test on All Real ROMs
  for (const fileName of romFiles) {
    const fullPath = path.join(LOCAL_ROMS_DIR, fileName);
    const bin = fs.readFileSync(fullPath).toString('binary');

    let p1VisualFrames = 0;
    let lastVisualFirstPixel = 0;
    const nes1 = new jsnes.NES({
      onFrame: (fb) => {
        p1VisualFrames++;
        lastVisualFirstPixel = fb[0];
      }
    });
    const nes2 = new jsnes.NES({});
    nes1.loadROM(bin);
    nes2.loadROM(bin);

    const eng1 = new NesNetplayEngine(nes1, {
      localPlayer: 1,
      online: true,
      inputDelayFrames: 3,
      enableRiftPacing: true,
      enableVisualSmoothing: true
    });
    const eng2 = new NesNetplayEngine(nes2, {
      localPlayer: 2,
      online: true,
      inputDelayFrames: 3,
      enableRiftPacing: true,
      enableVisualSmoothing: true
    });

    const q12 = [];
    const q21 = [];
    let nextFlush12 = 120; // Simulate asymmetric TCP clumping (PC1->PC2 clumps every ~65ms, PC2->PC1 every ~33ms)
    let nextFlush21 = 110;

    for (let tick = 0; tick < 540; tick++) {
      const nowMs = tick * 16.667;

      // Deliver clumped packets whose release timestamp has arrived
      while (q12.length > 0 && q12[0].deliverAt <= nowMs) {
        const item = q12.shift();
        eng2.receiveRemoteInputPacket(item.pkt, nowMs);
      }
      while (q21.length > 0 && q21[0].deliverAt <= nowMs) {
        const item = q21.shift();
        eng1.receiveRemoteInputPacket(item.pkt, nowMs);
      }

      // Dynamic 2-player inputs (Start presses + directional/action toggles to force mispredictions)
      const p1Mask =
        (tick % 50 === 12 ? INPUT_BITS.START : 0) |
        (tick > 80 && Math.floor(tick / 7) % 2 === 0 ? INPUT_BITS.RIGHT | INPUT_BITS.B : 0) |
        (tick > 160 && Math.floor(tick / 11) % 3 === 0 ? INPUT_BITS.A | INPUT_BITS.UP : 0);
      const p2Mask =
        (tick % 50 === 28 ? INPUT_BITS.START : 0) |
        (tick > 80 && Math.floor(tick / 6) % 2 === 0 ? INPUT_BITS.LEFT | INPUT_BITS.A : 0) |
        (tick > 160 && Math.floor(tick / 9) % 3 === 0 ? INPUT_BITS.B | INPUT_BITS.DOWN : 0);

      const r1 = eng1.stepNetplayFrame(p1Mask);
      const r2 = eng2.stepNetplayFrame(p2Mask);

      if (r1.packetToSend) {
        if (nowMs + 125 > nextFlush12) {
          nextFlush12 = nowMs + 125 + (tick % 4 === 0 ? 55 : 0);
        }
        q12.push({ deliverAt: nextFlush12, pkt: r1.packetToSend });
      }
      if (r2.packetToSend) {
        if (nowMs + 115 > nextFlush21) {
          nextFlush21 = nowMs + 115 + (tick % 2 === 0 ? 20 : 0);
        }
        q21.push({ deliverAt: nextFlush21, pkt: r2.packetToSend });
      }
    }

    // Drain remaining packets and step both emulators to the exact same final frame with neutral input
    let drainNow = 540 * 16.667 + 300;
    while (q12.length > 0) eng2.receiveRemoteInputPacket(q12.shift().pkt, drainNow);
    while (q21.length > 0) eng1.receiveRemoteInputPacket(q21.shift().pkt, drainNow);

    const targetFinalFrame = Math.max(eng1.currentFrame, eng2.currentFrame) + 12;
    while (eng1.currentFrame < targetFinalFrame || eng2.currentFrame < targetFinalFrame) {
      drainNow += 16.667;
      if (eng1.currentFrame < targetFinalFrame) {
        const r1 = eng1.stepNetplayFrame(0);
        if (r1.packetToSend) eng2.receiveRemoteInputPacket(r1.packetToSend, drainNow);
      }
      if (eng2.currentFrame < targetFinalFrame) {
        const r2 = eng2.stepNetplayFrame(0);
        if (r2.packetToSend) eng1.receiveRemoteInputPacket(r2.packetToSend, drainNow);
      }
    }
    // Final packet exchange to ensure any last-frame rollback settles
    const fin1 = eng1._buildInputPacket(eng1.lastLocalScheduledFrame);
    const fin2 = eng2._buildInputPacket(eng2.lastLocalScheduledFrame);
    eng2.receiveRemoteInputPacket(fin1, drainNow + 20);
    eng1.receiveRemoteInputPacket(fin2, drainNow + 20);
    const s1 = eng1.stepNetplayFrame(0);
    const s2 = eng2.stepNetplayFrame(0);
    if (s1.packetToSend) eng2.receiveRemoteInputPacket(s1.packetToSend, drainNow + 30);
    if (s2.packetToSend) eng1.receiveRemoteInputPacket(s2.packetToSend, drainNow + 30);

    const t1 = eng1.getTelemetry();
    const t2 = eng2.getTelemetry();
    const finalHash1 = formatHex32(computeDeterministicHash(nes1));
    const finalHash2 = formatHex32(computeDeterministicHash(nes2));

    assert.strictEqual(t1.desyncCount, 0, `Expected 0 desyncs on P1 for ${fileName}, got ${t1.desyncCount}`);
    assert.strictEqual(t2.desyncCount, 0, `Expected 0 desyncs on P2 for ${fileName}, got ${t2.desyncCount}`);
    assert.strictEqual(
      finalHash1,
      finalHash2,
      `Expected identical final state hash on ${fileName}: P1=${finalHash1} vs P2=${finalHash2}`
    );
    assert.ok(t2.rxClumpFrames > 0, `Expected P2 to detect TCP clumping (rxClumpFrames=${t2.rxClumpFrames})`);
    assert.ok(p1VisualFrames > 400 && typeof lastVisualFirstPixel === 'number');
    if (t1.maxRollbackDepthSeen >= 4) {
      assert.ok(
        t1.smoothedFramesCount > 0,
        `Expected 1-frame visual rollback smoothing to trigger on depth >= 4`
      );
    }

    console.log(
      `[PASS] Stage 2 Pinggy Torture (${fileName}): Rollbacks P1=${t1.rollbacksTotal} (max=${t1.maxRollbackDepthSeen}f, smoothed=${t1.smoothedFramesCount}), ` +
        `P2=${t2.rollbacksTotal} (max=${t2.maxRollbackDepthSeen}f, clump=${t2.rxClumpFrames}f) | 0 Desyncs | Final Hash=${finalHash1}`
    );
  }

  // Stage 3: Verify Dual-WebSocket Striping (bind_aux) & Server Input Deduplication
  const serverApp = createCoopServer({ logAccess: false });
  const port = await serverApp.listen(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  try {
    const p1Primary = new WebSocket(wsUrl);
    const p2Primary = new WebSocket(wsUrl);
    const p1Msgs = [];
    const p2Msgs = [];

    await Promise.all([
      new Promise((res) => p1Primary.once('open', res)),
      new Promise((res) => p2Primary.once('open', res))
    ]);

    p1Primary.on('message', (d) => p1Msgs.push(JSON.parse(d.toString())));
    p2Primary.on('message', (d) => p2Msgs.push(JSON.parse(d.toString())));

    p1Primary.send(JSON.stringify({ type: 'join_room', roomCode: 'STRIPE', clientId: 'cid_p1', nick: 'SG' }));
    p2Primary.send(JSON.stringify({ type: 'join_room', roomCode: 'STRIPE', clientId: 'cid_p2', nick: 'RU' }));

    await new Promise((res) => setTimeout(res, 60));

    // Attach auxiliary WebSockets (wsAux) for both P1 and P2
    const p1Aux = new WebSocket(`${wsUrl}?aux=1`);
    const p2Aux = new WebSocket(`${wsUrl}?aux=1`);
    const p2AuxMsgs = [];
    await Promise.all([
      new Promise((res) => p1Aux.once('open', res)),
      new Promise((res) => p2Aux.once('open', res))
    ]);
    p2Aux.on('message', (d) => p2AuxMsgs.push(JSON.parse(d.toString())));

    p1Aux.send(JSON.stringify({ type: 'bind_aux', roomCode: 'STRIPE', clientId: 'cid_p1' }));
    p2Aux.send(JSON.stringify({ type: 'bind_aux', roomCode: 'STRIPE', clientId: 'cid_p2' }));
    await new Promise((res) => setTimeout(res, 50));

    // Send duplicate netplay_input on both p1Primary and p1Aux
    const inputPkt = {
      type: 'netplay_input',
      sessionId: 'sess_stripe',
      player: 1,
      startFrame: 42,
      inputs: [INPUT_BITS.RIGHT],
      tailCount: 16
    };
    p1Aux.send(JSON.stringify(inputPkt));
    p1Primary.send(JSON.stringify(inputPkt));
    await new Promise((res) => setTimeout(res, 60));

    // Verify Server deduplicated the uplink (forwarded only once per downlink socket)
    // AND striped the downlink across both p2Primary and p2Aux!
    const p2PrimaryInputs = p2Msgs.filter((m) => m.type === 'netplay_input' && m.startFrame === 42);
    const p2AuxInputs = p2AuxMsgs.filter((m) => m.type === 'netplay_input' && m.startFrame === 42);
    assert.strictEqual(p2PrimaryInputs.length, 1, 'Expected server to deduplicate duplicate uplink packet on primary downlink');
    assert.strictEqual(p2AuxInputs.length, 1, 'Expected server to stripe netplay_input onto P2 auxiliary WebSocket');

    p1Primary.close();
    p2Primary.close();
    p1Aux.close();
    p2Aux.close();
    console.log('[PASS] Stage 3: Dual-WebSocket Striping (ws + wsAux) & Server Deduplication Verified');
  } finally {
    await serverApp.close();
  }

  // Stage 4: Verify Asymmetric Independent Input Delay (P1=4f vs P2=1f/0f) & Mid-Game Delay Reduction (5f -> 1f -> 0f)
  {
    const btddFile = romFiles.find((f) => f.toLowerCase().includes('battletoads')) || romFiles[0];
    const buf = fs.readFileSync(path.join(LOCAL_ROMS_DIR, btddFile));
    const binStr = buf.toString('binary');

    const nesA = new jsnes.NES({});
    const nesB = new jsnes.NES({});
    nesA.loadROM(binStr);
    nesB.loadROM(binStr);

    // P1 starts with 4f delay, P2 (Brother) starts with 5f and dynamically drops to 1f then 0f mid-game!
    const engA = new NesNetplayEngine(nesA, {
      localPlayer: 1,
      online: true,
      enableRiftPacing: true,
      inputDelayFrames: 4,
      sessionId: 'asym_delay_test'
    });
    const engB = new NesNetplayEngine(nesB, {
      localPlayer: 2,
      online: true,
      enableRiftPacing: true,
      inputDelayFrames: 5,
      sessionId: 'asym_delay_test'
    });

    const qAB = [];
    const qBA = [];
    for (let tick = 0; tick < 260; tick++) {
      const nowMs = tick * 16.667;
      if (tick === 40) {
        engB.setInputDelay(1);
      }
      if (tick === 130) {
        engB.setInputDelay(0);
      }

      while (qAB.length > 0 && qAB[0].at <= nowMs) engB.receiveRemoteInputPacket(qAB.shift().pkt, nowMs);
      while (qBA.length > 0 && qBA[0].at <= nowMs) engA.receiveRemoteInputPacket(qBA.shift().pkt, nowMs);

      const p1In =
        (tick % 50 === 12 ? INPUT_BITS.START : 0) |
        (tick > 60 && Math.floor(tick / 7) % 2 === 0 ? INPUT_BITS.RIGHT | INPUT_BITS.B : 0);
      const p2In =
        (tick % 50 === 28 ? INPUT_BITS.START : 0) |
        (tick > 60 && Math.floor(tick / 6) % 2 === 0 ? INPUT_BITS.LEFT | INPUT_BITS.A : 0);
      const rA = engA.stepNetplayFrame(p1In);
      const rB = engB.stepNetplayFrame(p2In);

      if (tick === 55 && rB.stepped) {
        // After dropping 5f -> 1f at tick 40, lastLocalScheduledFrame must have caught up to (currentFrame - 1) + 1
        assert.strictEqual(
          engB.lastLocalScheduledFrame - (engB.currentFrame - 1),
          1,
          'Expected P2 input delay lead to shrink from 5f down to 1f within 15 frames'
        );
      }
      if (tick === 145 && rB.stepped) {
        assert.strictEqual(
          engB.lastLocalScheduledFrame - (engB.currentFrame - 1),
          0,
          'Expected P2 input delay lead to shrink from 1f down to 0f within 15 frames'
        );
      }

      if (rA.packetToSend) qAB.push({ at: nowMs + 100, pkt: rA.packetToSend });
      if (rB.packetToSend) qBA.push({ at: nowMs + 100, pkt: rB.packetToSend });
    }

    // Drain & settle
    let drainT = 260 * 16.667 + 200;
    while (qAB.length > 0) engB.receiveRemoteInputPacket(qAB.shift().pkt, drainT);
    while (qBA.length > 0) engA.receiveRemoteInputPacket(qBA.shift().pkt, drainT);
    const finalTarget = Math.max(engA.currentFrame, engB.currentFrame) + 10;
    while (engA.currentFrame < finalTarget || engB.currentFrame < finalTarget) {
      drainT += 16.667;
      if (engA.currentFrame < finalTarget) {
        const rA = engA.stepNetplayFrame(0);
        if (rA.packetToSend) engB.receiveRemoteInputPacket(rA.packetToSend, drainT);
      }
      if (engB.currentFrame < finalTarget) {
        const rB = engB.stepNetplayFrame(0);
        if (rB.packetToSend) engA.receiveRemoteInputPacket(rB.packetToSend, drainT);
      }
    }
    engB.receiveRemoteInputPacket(engA._buildInputPacket(engA.lastLocalScheduledFrame), drainT + 10);
    engA.receiveRemoteInputPacket(engB._buildInputPacket(engB.lastLocalScheduledFrame), drainT + 10);
    engA.stepNetplayFrame(0);
    engB.stepNetplayFrame(0);

    assert.strictEqual(engA.desyncCount, 0, 'Expected 0 desyncs on P1 with asymmetric input delay');
    assert.strictEqual(engB.desyncCount, 0, 'Expected 0 desyncs on P2 with asymmetric input delay (5f -> 1f -> 0f)');
    const hashA = formatHex32(computeDeterministicHash(nesA));
    const hashB = formatHex32(computeDeterministicHash(nesB));
    assert.strictEqual(hashA, hashB, `Expected identical hash after asymmetric delay run: ${hashA} vs ${hashB}`);
    console.log(
      `[PASS] Stage 4: Asymmetric Independent Input Delay (P1=4f vs P2=5f->1f->0f) Verified (0 Desyncs, Hash=${hashA})`
    );
  }

  // Stage 5: Verify Power Blade 2 Bottom HUD Split Stability Across Online loadROM/resetTimeline & Rollback Audio De-Click
  {
    const pbFile = romFiles.find((f) => f.toLowerCase().includes('power blade'));
    if (pbFile) {
      const buf = fs.readFileSync(path.join(LOCAL_ROMS_DIR, pbFile));
      const binStr = buf.toString('binary');
      const audioSamples = [];
      const nesPb = new jsnes.NES({
        onAudioSample: (l) => audioSamples.push(l)
      });
      nesPb.loadROM(binStr);
      const engPb = new NesNetplayEngine(nesPb, {
        localPlayer: 2,
        online: true,
        inputDelayFrames: 1,
        sessionId: 'pb_hud_session_0'
      });

      // Simulate 2-PC Online Match Start (startLockstepMatchAtFrameZero / match_start_req)
      // which calls nes.loadROM() + engine.resetTimeline(0, newSessionId) AFTER engine creation!
      nesPb.loadROM(binStr);
      engPb.resetTimeline(0, 'pb_hud_session_1');

      assert.strictEqual(nesPb.ppu._patched8x16, true, 'Expected PPU HBlank split & headless patches to survive nes.loadROM()');
      assert.strictEqual(nesPb.mmap._fastBankPatched, true, 'Expected Mapper fast bank-switch patches to survive nes.loadROM()');
      assert.strictEqual(nesPb.rom._vromRefTagged, true, 'Expected VROM tile ref tags to survive nes.loadROM()');

      let hudStableFrames = 0;
      let hudJitterFrames = 0;
      let maxPostRollbackBoundaryJump = 0;

      for (let f = 0; f < 920; f++) {
        if (f >= 5) {
          const inputs = [];
          for (let rf = f - 4; rf >= Math.max(0, f - 14); rf--) {
            let p1 = rf >= 120 && rf < 650 && rf % 30 < 5 ? INPUT_BITS.START : 0;
            if (rf >= 650) {
              p1 = INPUT_BITS.RIGHT | (rf % 40 < 20 ? INPUT_BITS.A : 0) | (rf % 15 < 5 ? INPUT_BITS.B : 0);
            }
            inputs.push(p1);
          }
          engPb.receiveRemoteInputPacket({
            sessionId: 'pb_hud_session_1',
            startFrame: f - 4,
            inputs
          });
        }
        const beforeAudioLen = audioSamples.length;
        const prevRb = engPb.rollbacksTotal;
        engPb.stepNetplayFrame(0);
        const hadRb = engPb.rollbacksTotal > prevRb;

        if (f >= 780 && hadRb && audioSamples.length > beforeAudioLen && beforeAudioLen > 0) {
          const jump = Math.abs(audioSamples[beforeAudioLen] - audioSamples[beforeAudioLen - 1]);
          if (jump > maxPostRollbackBoundaryJump) {
            maxPostRollbackBoundaryJump = jump;
          }
        }

        if (f >= 780) {
          const fb = nesPb.ppu.buffer;
          const rowSig = (y) => {
            let s = 0;
            for (let x = 0; x < 256; x++) s = (s * 31 + (fb[y * 256 + x] & 0xffffff)) >>> 0;
            return s.toString(16).padStart(8, '0').slice(0, 4);
          };
          if (rowSig(184) === 'd0a8' && rowSig(185) === '9aa2') {
            hudStableFrames++;
          } else {
            hudJitterFrames++;
          }
        }
      }

      assert.strictEqual(hudJitterFrames, 0, `Expected 0 HUD scanline jitter frames in Power Blade 2, got ${hudJitterFrames}`);
      assert.strictEqual(hudStableFrames, 140, `Expected all 140 Stage 1 frames to keep HUD locked at y=184, got ${hudStableFrames}`);
      assert.ok(
        maxPostRollbackBoundaryJump < 0.02,
        `Expected post-rollback audio de-click ramp to keep sample jump < 0.02, got ${maxPostRollbackBoundaryJump.toFixed(4)}`
      );
      console.log(
        `[PASS] Stage 5: Power Blade 2 HUD Split Stability (${hudStableFrames}/140 frames locked at y=184, 0 jitter) & Audio De-Click (maxJump=${maxPostRollbackBoundaryJump.toFixed(4)}) Verified`
      );
    }
  }

  console.log('\nALL REAL NES ROM & ADVANCED NETCODE TESTS PASSED!');
}

runRealRomsSuite().catch((err) => {
  console.error('\n[FAIL] Real ROMs Test Suite Failed:', err);
  process.exit(1);
});
