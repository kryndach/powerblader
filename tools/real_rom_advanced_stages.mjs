/**
 * @fileoverview Stages 3, 4, and 5 of the Real NES ROMs & Netcode Optimization
 * Test Suite (Dual-WS Striping, Asymmetric Delay, Power Blade 2 HUD & Audio).
 *
 * Line width <= 80 chars, file size <= 350 lines.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import * as jsnesModule from 'jsnes';
import WebSocket from 'ws';
import {
  NesNetplayEngine,
  INPUT_BITS,
  computeDeterministicHash,
  formatHex32
} from '../src/netplay_engine.mjs';
import { createCoopServer } from '../server/relay_server.mjs';

const jsnes = jsnesModule.NES ? jsnesModule : jsnesModule.default;

export async function runStage3StripingAndDedup() {
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

    p1Primary.send(
      JSON.stringify({
        type: 'join_room',
        roomCode: 'STRIPE',
        clientId: 'cid_p1',
        nick: 'SG'
      })
    );
    p2Primary.send(
      JSON.stringify({
        type: 'join_room',
        roomCode: 'STRIPE',
        clientId: 'cid_p2',
        nick: 'RU'
      })
    );

    await new Promise((res) => setTimeout(res, 60));

    const p1Aux = new WebSocket(`${wsUrl}?aux=1`);
    const p2Aux = new WebSocket(`${wsUrl}?aux=1`);
    const p2AuxMsgs = [];
    await Promise.all([
      new Promise((res) => p1Aux.once('open', res)),
      new Promise((res) => p2Aux.once('open', res))
    ]);
    p2Aux.on('message', (d) => p2AuxMsgs.push(JSON.parse(d.toString())));

    p1Aux.send(
      JSON.stringify({
        type: 'bind_aux',
        roomCode: 'STRIPE',
        clientId: 'cid_p1'
      })
    );
    p2Aux.send(
      JSON.stringify({
        type: 'bind_aux',
        roomCode: 'STRIPE',
        clientId: 'cid_p2'
      })
    );
    await new Promise((res) => setTimeout(res, 50));

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

    const p2PrimaryInputs = p2Msgs.filter(
      (m) => m.type === 'netplay_input' && m.startFrame === 42
    );
    const p2AuxInputs = p2AuxMsgs.filter(
      (m) => m.type === 'netplay_input' && m.startFrame === 42
    );
    assert.strictEqual(p2PrimaryInputs.length, 1);
    assert.strictEqual(p2AuxInputs.length, 1);

    p1Primary.close();
    p2Primary.close();
    p1Aux.close();
    p2Aux.close();
    console.log(
      '[PASS] Stage 3: Dual-WebSocket Striping (ws + wsAux) & ' +
        'Server Deduplication Verified'
    );
  } finally {
    await serverApp.close();
  }
}

export function runStage4AsymmetricDelay(romFiles, localRomsDir) {
  const btddFile =
    romFiles.find((f) => f.toLowerCase().includes('battletoads')) ||
    romFiles[0];
  const buf = fs.readFileSync(path.join(localRomsDir, btddFile));
  const binStr = buf.toString('binary');

  const nesA = new jsnes.NES({});
  const nesB = new jsnes.NES({});
  nesA.loadROM(binStr);
  nesB.loadROM(binStr);

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
    if (tick === 40) engB.setInputDelay(1);
    if (tick === 130) engB.setInputDelay(0);

    while (qAB.length > 0 && qAB[0].at <= nowMs) {
      engB.receiveRemoteInputPacket(qAB.shift().pkt, nowMs);
    }
    while (qBA.length > 0 && qBA[0].at <= nowMs) {
      engA.receiveRemoteInputPacket(qBA.shift().pkt, nowMs);
    }

    const p1In =
      (tick % 50 === 12 ? INPUT_BITS.START : 0) |
      (tick > 60 && Math.floor(tick / 7) % 2 === 0
        ? INPUT_BITS.RIGHT | INPUT_BITS.B
        : 0);
    const p2In =
      (tick % 50 === 28 ? INPUT_BITS.START : 0) |
      (tick > 60 && Math.floor(tick / 6) % 2 === 0
        ? INPUT_BITS.LEFT | INPUT_BITS.A
        : 0);
    const rA = engA.stepNetplayFrame(p1In);
    const rB = engB.stepNetplayFrame(p2In);

    if (tick === 55 && rB.stepped) {
      assert.strictEqual(
        engB.lastLocalScheduledFrame - (engB.currentFrame - 1),
        1
      );
    }
    if (tick === 145 && rB.stepped) {
      assert.strictEqual(
        engB.lastLocalScheduledFrame - (engB.currentFrame - 1),
        0
      );
    }

    if (rA.packetToSend) qAB.push({ at: nowMs + 100, pkt: rA.packetToSend });
    if (rB.packetToSend) qBA.push({ at: nowMs + 100, pkt: rB.packetToSend });
  }

  let drainT = 260 * 16.667 + 200;
  while (qAB.length > 0) {
    engB.receiveRemoteInputPacket(qAB.shift().pkt, drainT);
  }
  while (qBA.length > 0) {
    engA.receiveRemoteInputPacket(qBA.shift().pkt, drainT);
  }
  const finalTarget = Math.max(engA.currentFrame, engB.currentFrame) + 10;
  while (engA.currentFrame < finalTarget || engB.currentFrame < finalTarget) {
    drainT += 16.667;
    if (engA.currentFrame < finalTarget) {
      const rA = engA.stepNetplayFrame(0);
      if (rA.packetToSend) {
        engB.receiveRemoteInputPacket(rA.packetToSend, drainT);
      }
    }
    if (engB.currentFrame < finalTarget) {
      const rB = engB.stepNetplayFrame(0);
      if (rB.packetToSend) {
        engA.receiveRemoteInputPacket(rB.packetToSend, drainT);
      }
    }
  }
  engB.receiveRemoteInputPacket(
    engA._buildInputPacket(engA.lastLocalScheduledFrame),
    drainT + 10
  );
  engA.receiveRemoteInputPacket(
    engB._buildInputPacket(engB.lastLocalScheduledFrame),
    drainT + 10
  );
  engA.stepNetplayFrame(0);
  engB.stepNetplayFrame(0);

  assert.strictEqual(engA.desyncCount, 0);
  assert.strictEqual(engB.desyncCount, 0);
  const hashA = formatHex32(computeDeterministicHash(nesA));
  const hashB = formatHex32(computeDeterministicHash(nesB));
  assert.strictEqual(hashA, hashB);
  console.log(
    '[PASS] Stage 4: Asymmetric Independent Input Delay ' +
      `(P1=4f vs P2=5f->1f->0f) Verified (0 Desyncs, Hash=${hashA})`
  );
}

export function runStage5PowerBladeHudAndAudio(romFiles, localRomsDir) {
  const pbFile = romFiles.find((f) => f.toLowerCase().includes('power blade'));
  if (!pbFile) return;

  const buf = fs.readFileSync(path.join(localRomsDir, pbFile));
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

  nesPb.loadROM(binStr);
  engPb.resetTimeline(0, 'pb_hud_session_1');

  assert.strictEqual(nesPb.ppu._patched8x16, true);
  assert.strictEqual(nesPb.mmap._fastBankPatched, true);
  assert.strictEqual(nesPb.rom._vromRefTagged, true);

  let hudStableFrames = 0;
  let hudJitterFrames = 0;
  let maxPostRollbackBoundaryJump = 0;

  for (let f = 0; f < 920; f++) {
    if (f >= 5) {
      const inputs = [];
      for (let rf = f - 4; rf >= Math.max(0, f - 14); rf--) {
        let p1 = rf >= 120 && rf < 650 && rf % 30 < 5 ? INPUT_BITS.START : 0;
        if (rf >= 650) {
          p1 =
            INPUT_BITS.RIGHT |
            (rf % 40 < 20 ? INPUT_BITS.A : 0) |
            (rf % 15 < 5 ? INPUT_BITS.B : 0);
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

    if (
      f >= 780 &&
      hadRb &&
      audioSamples.length > beforeAudioLen &&
      beforeAudioLen > 0
    ) {
      const jump = Math.abs(
        audioSamples[beforeAudioLen] - audioSamples[beforeAudioLen - 1]
      );
      if (jump > maxPostRollbackBoundaryJump) {
        maxPostRollbackBoundaryJump = jump;
      }
    }

    if (f >= 780) {
      const fb = nesPb.ppu.buffer;
      const rowSig = (y) => {
        let s = 0;
        for (let x = 0; x < 256; x++) {
          s = (s * 31 + (fb[y * 256 + x] & 0xffffff)) >>> 0;
        }
        return s.toString(16).padStart(8, '0').slice(0, 4);
      };
      if (rowSig(184) === 'd0a8' && rowSig(185) === '9aa2') {
        hudStableFrames++;
      } else {
        hudJitterFrames++;
      }
    }
  }

  assert.strictEqual(hudJitterFrames, 0);
  assert.strictEqual(hudStableFrames, 140);
  assert.ok(maxPostRollbackBoundaryJump < 0.02);
  console.log(
    '[PASS] Stage 5: Power Blade 2 HUD Split Stability ' +
      `(${hudStableFrames}/140 frames locked at y=184, 0 jitter) & ` +
      `Audio De-Click (maxJump=${maxPostRollbackBoundaryJump.toFixed(4)}) ` +
      'Verified'
  );
}
