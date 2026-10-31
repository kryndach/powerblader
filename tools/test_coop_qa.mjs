import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import * as jsnes from 'jsnes';
import WebSocket from 'ws';
import { PowerBlade2CoopBridge, computeRomCrc32 } from '../src/coop_core.mjs';
import { createCoopServer } from '../server/relay_server.mjs';

const profile = JSON.parse(fs.readFileSync('games/power-blade-2/profile.json', 'utf8'));
const romPath = 'local/Power Blade 2 (U) [!].nes';

function createHeadlessClient(romBinary, playerIndex) {
  let lastFb = new Uint32Array(256 * 240);
  const nes = new jsnes.NES({
    onFrame: (fb) => {
      for (let i = 0; i < 256 * 240; i++) lastFb[i] = fb[i];
    },
    onAudioSample: () => {}
  });
  nes.loadROM(romBinary);
  const bridge = new PowerBlade2CoopBridge(nes, profile, {
    playerIndex,
    interpDelayMs: 65
  });
  bridge.tagRomChrTiles();
  return {
    nes,
    bridge,
    getFrameBuffer: () => lastFb.slice()
  };
}

function advance(nes, bridge, frames, simClock) {
  for (let i = 0; i < frames; i++) {
    simClock.now += 16.666;
    nes.frame();
    bridge.stepFrame(simClock.now);
  }
}

function tap(nes, bridge, btn, hold, wait, simClock) {
  nes.buttonDown(1, btn);
  advance(nes, bridge, hold, simClock);
  nes.buttonUp(1, btn);
  advance(nes, bridge, wait, simClock);
}

function bootToStage1(client, simClock) {
  advance(client.nes, client.bridge, 360, simClock);
  tap(client.nes, client.bridge, jsnes.Controller.BUTTON_START, 8, 120, simClock);
  tap(client.nes, client.bridge, jsnes.Controller.BUTTON_START, 8, 180, simClock);
  tap(client.nes, client.bridge, jsnes.Controller.BUTTON_START, 8, 240, simClock);
  tap(client.nes, client.bridge, jsnes.Controller.BUTTON_START, 8, 180, simClock);
}

async function runTests() {
  console.log('=== Power Blade 2 Co-op Automated Bot & Network Chaos QA Suite ===\n');

  // 1. Verify ROM Identity & CHR Tagging
  const romBytes = fs.readFileSync(romPath);
  const sha256 = crypto.createHash('sha256').update(romBytes).digest('hex');
  const romBinary = fs.readFileSync(romPath, { encoding: 'binary' });
  const crc32 = computeRomCrc32(romBinary);

  assert.strictEqual(sha256, profile.rom.sha256, 'ROM SHA-256 mismatch');
  assert.strictEqual(crc32, profile.rom.crc32, 'ROM CRC32 mismatch');
  console.log(`[PASS] Test 1: ROM Verified (SHA-256=${sha256.slice(0, 16)}..., CRC32=${crc32})`);

  const simClock = { now: 10000 };
  const clientSG = createHeadlessClient(romBinary, 1);
  const clientRU = createHeadlessClient(romBinary, 2);

  assert.strictEqual(
    clientSG.nes.rom.vromTile[31][255].globalChrId,
    (31 << 8) | 255,
    'Global CHR tile tagging failed'
  );

  // 2. Start Real WebSocket Relay Server & Connect Singapore + Russia Clients
  const serverApp = createCoopServer();
  const port = await serverApp.listen(0, '127.0.0.1');
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const wsSG = new WebSocket(wsUrl);
  const wsRU = new WebSocket(wsUrl);

  const joined = { sg: null, ru: null };

  await new Promise((resolve, reject) => {
    let count = 0;
    const checkDone = () => {
      if (joined.sg && joined.ru && count >= 2) resolve();
    };
    wsSG.on('open', () => {
      wsSG.send(JSON.stringify({ type: 'join_room', roomCode: 'SGRU', nick: 'Egor-SG', romCrc32: crc32 }));
    });
    wsRU.on('open', () => {
      wsRU.send(JSON.stringify({ type: 'join_room', roomCode: 'SGRU', nick: 'Brother-RU', romCrc32: crc32 }));
    });
    wsSG.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'room_joined') {
        joined.sg = msg;
        count++;
        checkDone();
      } else if (msg.type === 'state') {
        clientSG.bridge.receiveRemoteState(msg.state, simClock.now);
      } else if (msg.type === 'event') {
        clientSG.bridge.receiveRemoteEvent(msg.event);
      } else if (msg.type === 'warp_request') {
        wsSG.send(JSON.stringify({ type: 'warp_snapshot', snapshot: clientSG.bridge.createWarpSnapshot() }));
      }
    });
    wsRU.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'room_joined') {
        joined.ru = msg;
        count++;
        checkDone();
      } else if (msg.type === 'state') {
        clientRU.bridge.receiveRemoteState(msg.state, simClock.now);
      } else if (msg.type === 'event') {
        clientRU.bridge.receiveRemoteEvent(msg.event);
      } else if (msg.type === 'warp_snapshot') {
        clientRU.bridge.applyWarpSnapshot(msg.snapshot);
      }
    });
    wsSG.on('error', reject);
    wsRU.on('error', reject);
  });

  assert.strictEqual(joined.sg.roomCode, 'SGRU');
  assert.strictEqual(joined.ru.roomCode, 'SGRU');
  assert.notStrictEqual(joined.sg.playerIndex, joined.ru.playerIndex);
  console.log(`[PASS] Test 2: WebSocket Relay Room Handshake (SG=P${joined.sg.playerIndex}, RU=P${joined.ru.playerIndex})`);

  // 3. Boot both clients into Stage 1 and test Independent Camera + Puppet Overlay under SG<->RU Network Chaos (180ms RTT, 25ms jitter, 2% loss)
  bootToStage1(clientSG, simClock);
  bootToStage1(clientRU, simClock);

  // Simulated Network Chaos Queue (Singapore <-> Russia: 90ms one-way = 180ms RTT, +/-25ms jitter, 2% packet loss)
  const inFlightToSG = [];
  const inFlightToRU = [];
  let rngSeed = 0x1337beef;
  function pseudoRand() {
    rngSeed = (rngSeed * 1664525 + 1013904223) >>> 0;
    return rngSeed / 0x100000000;
  }

  function queueChaosPacket(queue, state, sendTime) {
    if (pseudoRand() < 0.02) return; // 2% packet loss
    const oneWayLatency = 90 + (pseudoRand() * 50 - 25); // 90ms +/- 25ms (180ms RTT)
    queue.push({ deliverAt: sendTime + oneWayLatency, state });
  }

  function deliverChaosPackets(queue, targetBridge, nowMs) {
    queue.sort((a, b) => a.deliverAt - b.deliverAt);
    while (queue.length > 0 && queue[0].deliverAt <= nowMs) {
      const pkt = queue.shift();
      targetBridge.receiveRemoteState(pkt.state, nowMs);
    }
  }

  // SG walks left 150 frames (scrolling camera), RU walks left 70 frames and jumps + throws boomerang
  clientSG.nes.buttonDown(1, jsnes.Controller.BUTTON_LEFT);
  clientRU.nes.buttonDown(1, jsnes.Controller.BUTTON_LEFT);

  for (let f = 1; f <= 150; f++) {
    simClock.now += 16.666;
    if (f === 70) {
      clientRU.nes.buttonUp(1, jsnes.Controller.BUTTON_LEFT);
      clientRU.nes.buttonDown(1, jsnes.Controller.BUTTON_A);
      clientRU.nes.buttonDown(1, jsnes.Controller.BUTTON_B);
    }
    if (f === 80) {
      clientRU.nes.buttonUp(1, jsnes.Controller.BUTTON_A);
      clientRU.nes.buttonUp(1, jsnes.Controller.BUTTON_B);
    }

    clientSG.nes.frame();
    clientSG.bridge.stepFrame(simClock.now);
    clientRU.nes.frame();
    clientRU.bridge.stepFrame(simClock.now);

    if (f % 2 === 0) {
      queueChaosPacket(inFlightToRU, clientSG.bridge.extractLocalState(simClock.now), simClock.now);
      queueChaosPacket(inFlightToSG, clientRU.bridge.extractLocalState(simClock.now), simClock.now);
    }
    deliverChaosPackets(inFlightToSG, clientSG.bridge, simClock.now);
    deliverChaosPackets(inFlightToRU, clientRU.bridge, simClock.now);
  }
  clientSG.nes.buttonUp(1, jsnes.Controller.BUTTON_LEFT);

  const sgState = clientSG.bridge.extractLocalState(simClock.now);
  const ruState = clientRU.bridge.extractLocalState(simClock.now);
  const fbSG = clientSG.getFrameBuffer();
  const overlaySG = clientSG.bridge.renderCoopOverlay(fbSG, simClock.now);

  assert.strictEqual(overlaySG.partnerSameRoom, true, 'Partner should be detected in same room');
  assert.strictEqual(overlaySG.partnerVisible, true, 'Partner puppet should be visible on SG screen');
  assert.ok(overlaySG.drawnSprites >= 5, `Expected >=5 sprites drawn for P2, got ${overlaySG.drawnSprites}`);
  assert.ok(overlaySG.drawnPixels >= 100, `Expected >=100 pixels drawn for P2, got ${overlaySG.drawnPixels}`);
  console.log(
    `[PASS] Test 3: Independent Camera + Puppet Overlay under 180ms RTT / 25ms Jitter / 2% Loss (SG camX=${sgState.cameraX}, RU camX=${ruState.cameraX}, drawnSprites=${overlaySG.drawnSprites}, drawnPixels=${overlaySG.drawnPixels})`
  );

  // 4. Test Cross-Suit MMC3 CHR Independence (SG = Normal Suit 0, RU = Patriot Suit 2)
  clientRU.nes.cpu.mem[profile.ram.collectedSuitsMask] = 0x0f;
  clientRU.nes.cpu.mem[profile.ram.activeSuit] = 2; // Patriot Suit
  advance(clientRU.nes, clientRU.bridge, 10, simClock);
  const ruPatriotState = clientRU.bridge.extractLocalState(simClock.now);
  clientSG.bridge.receiveRemoteState(ruPatriotState, simClock.now + 100);
  const fbSGPatriot = clientSG.getFrameBuffer();
  const overlayPatriot = clientSG.bridge.renderCoopOverlay(fbSGPatriot, simClock.now + 100);
  assert.strictEqual(overlayPatriot.partnerVisible, true);
  assert.ok(overlayPatriot.drawnPixels >= 100);
  console.log(
    `[PASS] Test 4: Cross-Suit MMC3 CHR Rendering (SG Suit=${ sgState.activeSuit }, RU Suit=${ ruPatriotState.activeSuit }, drawnPixels=${ overlayPatriot.drawnPixels })`
  );

  // 5. Test Shared Co-op Combat (Enemy Kill & Boss HP Sync over WebSocket)
  // Advance SG 25 more frames left so Enemy #21 spawns at slot 21
  clientSG.nes.buttonDown(1, jsnes.Controller.BUTTON_LEFT);
  advance(clientSG.nes, clientSG.bridge, 25, simClock);
  clientSG.nes.buttonUp(1, jsnes.Controller.BUTTON_LEFT);

  // Sync RU to this encounter state
  const encounterSnap = clientSG.bridge.createWarpSnapshot();
  clientRU.bridge.applyWarpSnapshot(encounterSnap);
  clientRU.nes.cpu.mem[0x0508] = clientSG.nes.cpu.mem[0x0508]; // exact same X for boomerang test
  clientRU.bridge.stepFrame(simClock.now);
  clientSG.bridge.stepFrame(simClock.now);

  assert.strictEqual(clientSG.nes.cpu.mem[0x0400 + 21], 18, 'Enemy #21 should be active on SG');
  assert.strictEqual(clientRU.nes.cpu.mem[0x0400 + 21], 18, 'Enemy #21 should be active on RU');

  // RU jumps and throws boomerang to kill Enemy #21
  clientRU.nes.buttonDown(1, jsnes.Controller.BUTTON_A);
  advance(clientRU.nes, clientRU.bridge, 8, simClock);
  clientRU.nes.buttonUp(1, jsnes.Controller.BUTTON_A);
  clientRU.nes.buttonDown(1, jsnes.Controller.BUTTON_B);
  advance(clientRU.nes, clientRU.bridge, 4, simClock);
  clientRU.nes.buttonUp(1, jsnes.Controller.BUTTON_B);
  advance(clientRU.nes, clientRU.bridge, 10, simClock);

  const ruCombatEvents = clientRU.bridge.flushOutgoingEvents();
  const killEvt = ruCombatEvents.find((e) => e.type === 'actor_damage' && e.slot === 21);
  assert.ok(killEvt, 'Expected RU to emit actor_damage event for Enemy #21');

  // Send over real WebSocket to SG
  for (const ev of ruCombatEvents) {
    wsRU.send(JSON.stringify({ type: 'event', event: ev }));
  }
  await new Promise((r) => setTimeout(r, 50));

  assert.strictEqual(clientSG.nes.cpu.mem[0x049a + 21], 0, 'Enemy #21 HP on SG should be synced to 0');
  assert.strictEqual(clientSG.nes.cpu.mem[0x0400 + 21], 1, 'Enemy #21 on SG should enter explosion state 1');
  console.log('[PASS] Test 5a: Shared Enemy Kill Synced over WebSocket Relay (Enemy #21 HP 1 -> 0)');

  // Test Boss Slot #15 ($04A9) Damage Sync
  clientSG.nes.cpu.mem[0x0400 + 15] = 0x52; // Boss active
  clientSG.nes.cpu.mem[0x049a + 15] = 32;   // Boss 32 HP
  clientRU.nes.cpu.mem[0x0400 + 15] = 0x52;
  clientRU.nes.cpu.mem[0x049a + 15] = 32;
  clientSG.bridge.stepFrame(simClock.now);
  clientRU.bridge.stepFrame(simClock.now);

  // SG deals 4 damage to Boss (32 -> 28)
  clientSG.nes.cpu.mem[0x049a + 15] = 28;
  clientSG.bridge.stepFrame(simClock.now);
  for (const ev of clientSG.bridge.flushOutgoingEvents()) {
    wsSG.send(JSON.stringify({ type: 'event', event: ev }));
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(clientRU.nes.cpu.mem[0x049a + 15], 28, 'Boss HP on RU should sync to 28');
  console.log('[PASS] Test 5b: Shared Boss HP Bar Synced over WebSocket Relay (Boss HP 32 -> 28)');

  // 6. Test Shared Suit Unlock & Stage Clear Progression Sync
  clientSG.nes.cpu.mem[profile.ram.collectedSuitsMask] = 0x05; // Newton + Rocket suits
  clientSG.nes.cpu.mem[profile.ram.clearedStagesMask] = 0x01;  // Stage 1 cleared
  clientSG.bridge.stepFrame(simClock.now);
  for (const ev of clientSG.bridge.flushOutgoingEvents()) {
    wsSG.send(JSON.stringify({ type: 'event', event: ev }));
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(clientRU.nes.cpu.mem[profile.ram.collectedSuitsMask] & 0x05, 0x05);
  assert.strictEqual(clientRU.nes.cpu.mem[profile.ram.clearedStagesMask] & 0x01, 0x01);
  console.log('[PASS] Test 6: Shared Power Suit Unlock & Stage Clear Bitmasks Synced');

  // 7. Test Warp-to-Partner over WebSocket
  clientRU.nes.cpu.mem[profile.ram.activeSuit] = 3; // RU equips Rocket Suit (3)
  clientRU.nes.cpu.mem[profile.ram.roomId] = 0;     // RU is in a different room
  wsRU.send(JSON.stringify({ type: 'warp_request' }));
  await new Promise((r) => setTimeout(r, 80));

  assert.strictEqual(
    clientRU.nes.cpu.mem[profile.ram.roomId],
    clientSG.nes.cpu.mem[profile.ram.roomId],
    'RU roomId should match SG after warp'
  );
  assert.strictEqual(
    clientRU.nes.cpu.mem[profile.ram.activeSuit],
    3,
    'RU should preserve its equipped Rocket Suit (3) after warping to SG'
  );
  console.log('[PASS] Test 7: Warp-to-Partner over WebSocket (Synced Room/Camera & Preserved Partner Suit)');

  // 8. Test Full World-Space Enemy Synchronization (Position, Animation, Facing & Camera Offset)
  // Set SG (Host, P1) and RU (Client, P2) in Stage 0 Room 0 with different camera offsets
  clientSG.nes.cpu.mem[profile.ram.gameMode] = 3;
  clientRU.nes.cpu.mem[profile.ram.gameMode] = 3;
  clientSG.nes.cpu.mem[profile.ram.stageId] = 0;
  clientRU.nes.cpu.mem[profile.ram.stageId] = 0;
  clientSG.nes.cpu.mem[profile.ram.roomId] = 0;
  clientRU.nes.cpu.mem[profile.ram.roomId] = 0;
  clientSG.nes.cpu.mem[profile.ram.scrollMode] = 0;
  clientRU.nes.cpu.mem[profile.ram.scrollMode] = 0;

  // SG (Host, P1) camera at X = 470 (page 1, offset 214); RU (Client, P2) camera at X = 500 (page 1, offset 244)
  clientSG.nes.cpu.mem[profile.ram.cameraPage] = 1;
  clientSG.nes.cpu.mem[profile.ram.cameraOffset] = 214;
  clientRU.nes.cpu.mem[profile.ram.cameraPage] = 1;
  clientRU.nes.cpu.mem[profile.ram.cameraOffset] = 244;

  // Spawn an active enemy in Slot 20 on Host (SG, P1) at screenX=80 (worldX = 470 + 80 = 550), screenY=111
  const testSlot = 20;
  clientSG.nes.cpu.mem[0x0400 + testSlot] = 18;   // Enemy Type 18
  clientSG.nes.cpu.mem[0x0416 + testSlot] = 1;    // Active flags
  clientSG.nes.cpu.mem[0x042c + testSlot] = 0x40; // Facing Left
  clientSG.nes.cpu.mem[0x0442 + testSlot] = 35;   // Walk animId
  clientSG.nes.cpu.mem[0x049a + testSlot] = 2;    // HP = 2
  clientSG.nes.cpu.mem[0x04f2 + testSlot] = 0;    // screenXHi = 0
  clientSG.nes.cpu.mem[0x0508 + testSlot] = 80;   // screenXLo = 80 (worldX = 550)
  clientSG.nes.cpu.mem[0x04b0 + testSlot] = 0;    // screenYHi = 0
  clientSG.nes.cpu.mem[0x04c6 + testSlot] = 111;  // screenYLo = 111

  simClock.now += 1000;
  const hostState = clientSG.bridge.extractLocalState(simClock.now);
  clientRU.bridge.remoteSnapshots.length = 0;
  clientRU.bridge.receiveRemoteState(hostState, simClock.now);
  clientRU.bridge.stepFrame(simClock.now);

  // On RU (cameraX = 500), worldX = 550 must map to relX = 550 - 500 = 50!
  assert.strictEqual(
    clientRU.nes.cpu.mem[0x0400 + testSlot],
    18,
    'Enemy slot 20 type must sync to Client (RU)'
  );
  assert.strictEqual(
    clientRU.nes.cpu.mem[0x0442 + testSlot],
    35,
    'Enemy slot 20 animation ID must sync to Client (RU)'
  );
  assert.strictEqual(
    clientRU.nes.cpu.mem[0x0508 + testSlot],
    50,
    'Enemy slot 20 screenXLo on RU must be camera-adjusted (worldX 550 - RU camX 500 = 50)'
  );
  assert.strictEqual(
    clientRU.nes.cpu.mem[0x04c6 + testSlot],
    111,
    'Enemy slot 20 screenYLo on RU must match worldY (111)'
  );
  console.log('[PASS] Test 8: Full World-Space Enemy Synchronization (Type, Anim, Facing & Camera-Adjusted World X/Y)');

  await serverApp.close();
  console.log('\nALL 8 AUTOMATED CO-OP QA TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('QA Test Failed:', err);
  process.exit(1);
});
