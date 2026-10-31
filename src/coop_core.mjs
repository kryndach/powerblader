/**
 * Power Blade 2 (NES) — Dual-Emulator Memory & Sprite Sync Co-op Core
 * Works in both Browser (Canvas/WebSocket) and Node.js (Headless Bot QA).
 */

export const SUIT_NAMES = ['Normal', 'Newton', 'Patriot', 'Rocket', 'Wet'];

// Distinct Player 2 Co-op Palette (24-bit BGR format used by jsnes: 0xBBGGRR)
export const P2_PALETTE_REMAP = [
  // Palette 0 (Nova Hair / Face / Armor highlight)
  [0x000000, 0xffe040, 0x50d8ff, 0x70ff90],
  // Palette 1 (Nova Suit / Boomerang primary)
  [0x000000, 0x90ff40, 0xffd030, 0xffffff],
  // Palette 2 (Projectiles / Effects)
  [0x000000, 0xff80ff, 0x40ffff, 0xffffff],
  // Palette 3 (Pickups / Explosion accents)
  [0x000000, 0x40ff80, 0x80ffff, 0xffffff]
];

const MINI_GLYPHS = {
  P: [
    [1, 1, 1, 0],
    [1, 0, 0, 1],
    [1, 1, 1, 0],
    [1, 0, 0, 0],
    [1, 0, 0, 0]
  ],
  2: [
    [1, 1, 1, 0],
    [0, 0, 0, 1],
    [0, 1, 1, 0],
    [1, 0, 0, 0],
    [1, 1, 1, 1]
  ],
  '<': [
    [0, 0, 1],
    [0, 1, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ],
  '>': [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0, 1, 0],
    [1, 0, 0]
  ],
  '^': [
    [0, 1, 0],
    [1, 0, 1],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ],
  v: [
    [0, 0, 0],
    [0, 0, 0],
    [1, 0, 1],
    [0, 1, 0],
    [0, 0, 0]
  ]
};

export function computeRomCrc32(romBinaryString) {
  let crc = 0xffffffff;
  for (let i = 16; i < romBinaryString.length; i++) {
    crc ^= romBinaryString.charCodeAt(i) & 0xff;
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function hashTilePix(pix) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < 64; i++) {
    h1 = Math.imul(h1 ^ pix[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (pix[i] + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16)}_${h2.toString(16)}`;
}

export class PowerBlade2CoopBridge {
  constructor(nes, profile, options = {}) {
    this.nes = nes;
    this.profile = profile;
    this.playerIndex = options.playerIndex || 1;
    this.interpDelayMs = options.interpDelayMs ?? 60;
    this.enableP2Palette = options.enableP2Palette ?? true;
    this.enableRadar = options.enableRadar ?? true;

    this.oamOwner = new Int8Array(64).fill(-1);
    this.gameplayPtTile = new Array(512);
    this._hookedCpu = null;
    this._hookedMmap = null;
    this._hookedPpu = null;
    this.chrPixLookup = new Map();
    this.frameCounter = 0;

    // Track local enemy/boss HP and progression flags to detect deltas
    this.prevEnemyHp = new Uint8Array(22);
    this.prevEnemyType = new Uint8Array(22);
    this.prevRoomKey = -1;
    this.prevCollectedSuits = 0;
    this.prevClearedStages = 0;
    this.prevPlayerHp = 16;

    // Remote partner snapshot ring buffer for smooth interpolation
    this.remoteSnapshots = [];
    this.latestRemoteState = null;
    this.lastRemotePacketAt = 0;

    // Pending outgoing events (combat hits, progression unlocks)
    this.outgoingEvents = [];

    // Cooldown map so remote projectile doesn't hit the same enemy slot every single frame
    this.remoteHitCooldowns = new Uint8Array(22);
    // Lock timer per slot when P2 damages/kills/spawns an enemy locally so in-flight P1 state doesn't overwrite it
    this.localDamageLock = new Uint8Array(22);
    this._lastStepNowMs = Date.now();

    this._ensureCpuHook();
  }

  _ensureCpuHook() {
    const cpu = this.nes.cpu;
    if (cpu && this._hookedCpu !== cpu) {
      const origWrite = cpu.write.bind(cpu);
      const oamOwner = this.oamOwner;
      const actorSlotAddr = this.profile.ram.oamCurrentActorSlot; // 0x000D
      const self = this;

      cpu.write = function (addr, val) {
        if (addr >= 0x0200 && addr < 0x0300) {
          // Right at the start of Bank 6 $8051 OAM build, sync P2 enemies to P2's newly-updated camera
          if (addr === 0x0200 && val === 0xf4 && this.REG_PC === 0x8053) {
            if (self.playerIndex === 2 && self.enableEnemySync !== false) {
              self._detectLocalEnemyChanges(this.mem);
              self._syncEnemiesFromHost(self._lastStepNowMs);
            }
          }
          const slot = (addr - 0x0200) >> 2;
          const byteInSprite = addr & 3;
          if (byteInSprite === 0 && val >= 0xf0) {
            oamOwner[slot] = -1;
          } else if (byteInSprite === 3) {
            if (this.REG_PC >= 0x80b0 && this.REG_PC <= 0x8145) {
              oamOwner[slot] = this.mem[actorSlotAddr];
            } else {
              oamOwner[slot] = -1;
            }
          }
        }
        return origWrite(addr, val);
      };
      this._hookedCpu = cpu;
    }

    // Fix upstream jsnes v2.1.0 8x16 sprite bug (topTileNum - 1 + 256 -> topTileNum + 256)
    const ppu = this.nes.ppu;
    if (ppu && this._hookedPpu !== ppu) {
      ppu.renderSpritesPartially = function (startscan, scancount, bgPri) {
        if (this.f_spVisibility !== 1) return;
        const mmap = this.nes.mmap;
        const ptTile = this.ptTile;
        const buffer = this.buffer;
        const sprPalette = this.sprPalette;
        const pixrendered = this.pixrendered;

        for (let scan = startscan; scan < startscan + scancount; scan++) {
          if (scan < 0 || scan >= 240) continue;
          const count = this.scanlineSpriteCount[scan];
          const oamBase = scan * 32;

          for (let i = 0; i < count; i++) {
            const sprY = this.scanlineSecondaryOAM[oamBase + i * 4 + 0];
            const sprTile = this.scanlineSecondaryOAM[oamBase + i * 4 + 1];
            const sprAttr = this.scanlineSecondaryOAM[oamBase + i * 4 + 2];
            const sprX = this.scanlineSecondaryOAM[oamBase + i * 4 + 3];

            const vertFlip = (sprAttr >> 7) & 1;
            const horiFlip = (sprAttr >> 6) & 1;
            const priority = (sprAttr >> 5) & 1;
            const palAdd = (sprAttr & 3) << 2;

            if (priority !== bgPri) continue;
            if (this.f_spriteSize === 0) {
              const tileIndex = this.f_spPatternTable === 0 ? sprTile : sprTile + 256;
              const sprBaseAddr = this.f_spPatternTable === 0 ? 0x0000 : 0x1000;
              const dy = sprY + 1;
              const fineY = scan - dy;
              if (fineY < 0 || fineY >= 8) continue;

              ptTile[tileIndex].render(
                buffer,
                0,
                fineY,
                8,
                fineY + 1,
                sprX,
                dy,
                palAdd,
                sprPalette,
                horiFlip,
                vertFlip,
                i,
                pixrendered
              );
              mmap.latchAccess(sprBaseAddr + sprTile * 16 + 8);
            } else {
              const sprBaseAddr = (sprTile & 1) !== 0 ? 0x1000 : 0x0000;
              const topTileNum = sprTile & 0xfe;
              const top = (sprTile & 1) !== 0 ? topTileNum + 256 : topTileNum;

              const dy = sprY + 1;
              const fineY = scan - dy;
              if (fineY < 0 || fineY >= 16) continue;

              let tileOffset;
              let tileFineY;
              if (fineY < 8) {
                tileOffset = vertFlip ? 1 : 0;
                tileFineY = fineY;
              } else {
                tileOffset = vertFlip ? 0 : 1;
                tileFineY = fineY - 8;
              }

              ptTile[top + tileOffset].render(
                buffer,
                0,
                tileFineY,
                8,
                tileFineY + 1,
                sprX,
                dy + (fineY < 8 ? 0 : 8),
                palAdd,
                sprPalette,
                horiFlip,
                vertFlip,
                i,
                pixrendered
              );

              mmap.latchAccess(sprBaseAddr + topTileNum * 16 + 8);
              mmap.latchAccess(sprBaseAddr + (topTileNum + 1) * 16 + 8);
            }
          }
        }
      };
      this._hookedPpu = ppu;
    }

    const mmap = this.nes.mmap;
    if (mmap && this._hookedMmap !== mmap && typeof mmap.load1kVromBank === 'function') {
      const origLoad1k = mmap.load1kVromBank.bind(mmap);
      const gameplayPtTile = this.gameplayPtTile;
      mmap.load1kVromBank = function (bank1k, address) {
        origLoad1k(bank1k, address);
        if (this.nes.ppu && this.nes.ppu.scanline < 120) {
          const baseIndex = address >> 4;
          for (let i = 0; i < 64; i++) {
            gameplayPtTile[baseIndex + i] = this.nes.ppu.ptTile[baseIndex + i];
          }
        }
      };
      this._hookedMmap = mmap;
    }
  }

  tagRomChrTiles() {
    this._ensureCpuHook();
    if (this.nes.ppu && this.nes.ppu.ptTile) {
      for (let i = 0; i < 512; i++) {
        if (!this.gameplayPtTile[i]) {
          this.gameplayPtTile[i] = this.nes.ppu.ptTile[i];
        }
      }
    }
    if (!this.nes.rom || !this.nes.rom.vromTile) return;
    const vromTile = this.nes.rom.vromTile;
    this.chrPixLookup.clear();
    for (let bank4k = 0; bank4k < vromTile.length; bank4k++) {
      const bank = vromTile[bank4k];
      if (!bank) continue;
      for (let t = 0; t < bank.length; t++) {
        const tileObj = bank[t];
        if (tileObj) {
          const gid = (bank4k << 8) | (t & 0xff);
          tileObj.globalChrId = gid;
          if (tileObj.pix) {
            const key = hashTilePix(tileObj.pix);
            if (!this.chrPixLookup.has(key)) {
              this.chrPixLookup.set(key, gid);
            }
          }
        }
      }
    }
  }

  _resolveGlobalChrId(tileObj, fallbackPtIdx) {
    if (!tileObj) return fallbackPtIdx;
    if (tileObj.globalChrId !== undefined) return tileObj.globalChrId;
    if (tileObj.pix) {
      const gid = this.chrPixLookup.get(hashTilePix(tileObj.pix));
      if (gid !== undefined) {
        tileObj.globalChrId = gid;
        return gid;
      }
    }
    return fallbackPtIdx;
  }

  getCameraWorld(ram) {
    const r = this.profile.ram;
    const scrollMode = ram[r.scrollMode];
    const page = ram[r.cameraPage];
    const offset = ram[r.cameraOffset];
    if (scrollMode === 0) {
      return {
        cameraX: (page << 8) | offset,
        cameraY: 0,
        scrollMode: 0
      };
    } else {
      return {
        cameraX: 0,
        cameraY: page * 240 + offset,
        scrollMode
      };
    }
  }

  extractLocalState(nowMs = Date.now()) {
    this._ensureCpuHook();
    const ram = this.nes.cpu.mem;
    const r = this.profile.ram;
    const soa = r.soa;

    const stageId = ram[r.stageId];
    const roomId = ram[r.roomId];
    const gameMode = ram[r.gameMode];
    const { cameraX, cameraY, scrollMode } = this.getCameraWorld(ram);

    const playerScreenX = ram[soa.screenXLo + 0];
    const playerScreenY = ram[soa.screenYLo + 0];
    const playerWorldX = cameraX + playerScreenX;
    const playerWorldY = cameraY + playerScreenY;

    const hp = ram[soa.hp + 0];
    const bossHp = ram[soa.hp + soa.bossSlot];
    const bossType = ram[soa.type + soa.bossSlot];
    const suitEnergy = ram[r.suitEnergy];
    const activeSuit = ram[r.activeSuit];
    const collectedSuits = ram[r.collectedSuitsMask];
    const clearedStages = ram[r.clearedStagesMask];
    const lives = ram[r.lives];
    const eTanks = ram[r.eTanks];
    const lTanks = ram[r.lTanks];
    const facing = ram[soa.facing + 0];
    const animId = ram[soa.animId + 0];

    // Extract OAM sprites owned by Player (slot 0) and Player Projectiles (slots 1..5)
    const sprites = [];
    const ptTile = this.nes.ppu.ptTile;
    const is8x16 = this.nes.ppu.f_spriteSize === 1;
    const spPatternBase = this.nes.ppu.f_spPatternTable ? 256 : 0;

    for (let s = 0; s < 64; s++) {
      const owner = this.oamOwner[s];
      if (owner < 0 || owner > 5) continue;
      const base = 0x0200 + (s << 2);
      const sy = ram[base];
      if (sy === 0 || sy >= this.profile.constants.hudScanlineY) continue;
      const tileByte = ram[base + 1];
      const attr = ram[base + 2];
      const sx = ram[base + 3];

      let ptIdxTop = 0;
      let ptIdxBot = 0;
      if (is8x16) {
        ptIdxTop = ((tileByte & 1) << 8) | (tileByte & 0xfe);
        ptIdxBot = ptIdxTop + 1;
      } else {
        ptIdxTop = spPatternBase + tileByte;
        ptIdxBot = -1;
      }

      const topTileObj = this.gameplayPtTile[ptIdxTop] || ptTile[ptIdxTop];
      const botTileObj =
        ptIdxBot >= 0 ? this.gameplayPtTile[ptIdxBot] || ptTile[ptIdxBot] : null;
      const topChr = this._resolveGlobalChrId(topTileObj, ptIdxTop);
      const botChr = botTileObj ? this._resolveGlobalChrId(botTileObj, ptIdxBot) : -1;

      const dx = sx - playerScreenX;
      const dy = sy - playerScreenY;
      if (owner === 0 && (Math.abs(dx) > 32 || dy < -48 || dy > 24)) {
        continue;
      }

      sprites.push({
        dx,
        dy,
        worldX: cameraX + sx,
        worldY: cameraY + sy,
        topChr,
        botChr,
        attr,
        owner
      });
    }

    // Extract active projectile slots (1..5) for remote hitbox collision
    const projectiles = [];
    for (const pSlot of soa.projectileSlots) {
      const pType = ram[soa.type + pSlot];
      if (pType !== 0) {
        const px = ram[soa.screenXLo + pSlot];
        const py = ram[soa.screenYLo + pSlot];
        projectiles.push({
          slot: pSlot,
          type: pType,
          worldX: cameraX + px,
          worldY: cameraY + py
        });
      }
    }

    // Extract active enemy / boss / item slots (6..21) in world coordinates for deterministic co-op sync
    const enemies = [];
    for (let s = soa.enemySlotStart; s < soa.slotCount; s++) {
      if (ram[soa.type + s] !== 0) {
        enemies.push(this._extractEnemySlot(ram, s, cameraX, cameraY, scrollMode));
      }
    }
    const killedCount = Math.min(14, ram[0x0171] || 0);
    const killedSpawnIds = [];
    for (let i = 0; i < killedCount; i++) {
      killedSpawnIds.push(ram[0x0172 + i]);
    }

    return {
      t: nowMs,
      seq: this.frameCounter,
      stageId,
      roomId,
      gameMode,
      scrollMode,
      cameraX,
      cameraY,
      screenX: playerScreenX,
      screenY: playerScreenY,
      worldX: playerWorldX,
      worldY: playerWorldY,
      facing,
      animId,
      hp,
      bossHp,
      bossType,
      suitEnergy,
      activeSuit,
      collectedSuits,
      clearedStages,
      lives,
      eTanks,
      lTanks,
      sprites,
      projectiles,
      enemies,
      killedSpawnIds
    };
  }

  _extractEnemySlot(ram, s, cameraX, cameraY, scrollMode) {
    const sxHi = ram[0x04f2 + s] > 127 ? ram[0x04f2 + s] - 256 : ram[0x04f2 + s];
    const syHi = ram[0x04b0 + s] > 127 ? ram[0x04b0 + s] - 256 : ram[0x04b0 + s];
    const relX = (sxHi << 8) | ram[0x0508 + s];
    const relY = (syHi << 8) | ram[0x04c6 + s];
    const worldX = scrollMode === 0 ? cameraX + relX : relX;
    const worldY = scrollMode === 0 ? relY : cameraY + relY;

    const soaBytes = new Array(36);
    for (let a = 0; a < 36; a++) {
      soaBytes[a] = ram[0x0400 + a * 22 + s];
    }
    return {
      slot: s,
      type: ram[0x0400 + s],
      flags: ram[0x0416 + s],
      spawnId: ram[0x0484 + s],
      hp: ram[0x049a + s],
      worldX,
      worldY,
      soa: soaBytes
    };
  }

  _writeEnemySlotToRam(ram, s, enemy, cameraX, cameraY, scrollMode) {
    if (Array.isArray(enemy.soa) && enemy.soa.length === 36) {
      for (let a = 0; a < 36; a++) {
        ram[0x0400 + a * 22 + s] = enemy.soa[a];
      }
    }
    const relX = scrollMode === 0 ? Math.round(enemy.worldX - cameraX) : Math.round(enemy.worldX);
    const relY = scrollMode === 0 ? Math.round(enemy.worldY) : Math.round(enemy.worldY - cameraY);

    ram[0x0508 + s] = relX & 0xff;
    ram[0x04f2 + s] = (relX >> 8) & 0xff;
    ram[0x04c6 + s] = relY & 0xff;
    ram[0x04b0 + s] = (relY >> 8) & 0xff;
  }

  _detectLocalEnemyChanges(ram) {
    const r = this.profile.ram;
    const soa = r.soa;
    const gameMode = ram[r.gameMode];
    if (gameMode !== this.profile.constants.gameModeGameplay) return;

    const stageId = ram[r.stageId];
    const roomId = ram[r.roomId];
    const roomKey = (stageId << 8) | roomId;
    if (roomKey !== this.prevRoomKey) return;

    const { cameraX, cameraY, scrollMode } = this.getCameraWorld(ram);

    for (let s = soa.enemySlotStart; s < soa.slotCount; s++) {
      const curType = ram[soa.type + s];
      const curHp = ram[soa.hp + s];
      const prevType = this.prevEnemyType[s];
      const prevHp = this.prevEnemyHp[s];

      if (prevType > 1 && prevHp > 0 && prevHp !== 0xff) {
        if (curType === 0 || curType === 1 || (ram[soa.flags + s] & 0x80) !== 0) {
          this.outgoingEvents.push({
            type: 'actor_damage',
            stageId,
            roomId,
            slot: s,
            actorType: prevType,
            damage: prevHp,
            hpAfter: 0,
            killed: true
          });
          this.localDamageLock[s] = 24;
          this.prevEnemyType[s] = curType;
          this.prevEnemyHp[s] = 0;
        } else if (curType === prevType && curHp < prevHp) {
          this.outgoingEvents.push({
            type: 'actor_damage',
            stageId,
            roomId,
            slot: s,
            actorType: curType,
            damage: prevHp - curHp,
            hpAfter: curHp,
            killed: false
          });
          this.localDamageLock[s] = 24;
          this.prevEnemyType[s] = curType;
          this.prevEnemyHp[s] = curHp;
        }
      } else if (
        this.playerIndex === 2 &&
        prevType === 0 &&
        curType > 1 &&
        curHp > 0 &&
        (ram[soa.flags + s] & 0x80) === 0
      ) {
        // Player 2 scrolled ahead and triggered a local enemy spawn; notify Player 1 (Host)
        const spawnId = ram[0x0484 + s];
        const hostEnemies = this.latestRemoteState?.enemies || [];
        const alreadyOnHost = hostEnemies.some(
          (e) => (spawnId !== 0 && e.spawnId === spawnId) || e.slot === s
        );
        if (!alreadyOnHost) {
          this.outgoingEvents.push({
            type: 'actor_spawn',
            stageId,
            roomId,
            slot: s,
            enemy: this._extractEnemySlot(ram, s, cameraX, cameraY, scrollMode)
          });
          this.localDamageLock[s] = 24;
          this.prevEnemyType[s] = curType;
          this.prevEnemyHp[s] = curHp;
        }
      }
    }
  }

  _syncEnemiesFromHost(nowMs = Date.now()) {
    if (this.playerIndex !== 2 || this.enableEnemySync === false) return;
    const remote = this.getInterpolatedRemoteState(nowMs);
    if (!remote || !Array.isArray(remote.enemies)) return;
    if (remote.gameMode !== this.profile.constants.gameModeGameplay) return;

    const ram = this.nes.cpu.mem;
    const r = this.profile.ram;
    const soa = r.soa;
    if (ram[r.gameMode] !== this.profile.constants.gameModeGameplay) return;
    if (ram[r.stageId] !== remote.stageId || ram[r.roomId] !== remote.roomId) return;

    // Sync room killed-enemy spawn IDs ($0171..$017F)
    if (Array.isArray(remote.killedSpawnIds)) {
      const existing = new Set();
      const curCount = Math.min(14, ram[0x0171] || 0);
      for (let i = 0; i < curCount; i++) existing.add(ram[0x0172 + i]);
      for (const id of remote.killedSpawnIds) existing.add(id);
      const merged = Array.from(existing).slice(0, 14);
      ram[0x0171] = merged.length;
      for (let i = 0; i < merged.length; i++) {
        ram[0x0172 + i] = merged[i];
      }
    }

    const { cameraX, cameraY, scrollMode } = this.getCameraWorld(ram);
    const bySlot = new Map();
    const hostSpawnIds = new Map();
    for (const e of remote.enemies) {
      bySlot.set(e.slot, e);
      if (e.spawnId > 0) {
        hostSpawnIds.set(e.spawnId, e.slot);
      }
    }

    // Deduplicate any P2 slot that holds the same room enemy (spawnId) in a different slot index than Host P1
    for (let s = soa.enemySlotStart; s < soa.slotCount; s++) {
      const spId = ram[0x0484 + s];
      if (ram[soa.type + s] !== 0 && spId > 0 && hostSpawnIds.has(spId) && hostSpawnIds.get(spId) !== s) {
        ram[soa.type + s] = 0;
        ram[soa.flags + s] = 0;
        ram[soa.animId + s] = 0;
        ram[soa.hp + s] = 0;
        ram[0x04f2 + s] = 0xff;
        ram[0x0508 + s] = 0xf0;
      }
    }

    for (let s = soa.enemySlotStart; s < soa.slotCount; s++) {
      if (this.localDamageLock[s] > 0) continue;
      const hostEnemy = bySlot.get(s);
      if (hostEnemy && hostEnemy.type !== 0) {
        this._writeEnemySlotToRam(ram, s, hostEnemy, cameraX, cameraY, scrollMode);
        this.prevEnemyType[s] = ram[soa.type + s];
        this.prevEnemyHp[s] = ram[soa.hp + s];
      } else if (ram[soa.type + s] !== 0) {
        const localEnemy = this._extractEnemySlot(ram, s, cameraX, cameraY, scrollMode);
        const inHostZone =
          scrollMode === 0
            ? localEnemy.worldX >= remote.cameraX - 24 && localEnemy.worldX <= remote.cameraX + 280
            : localEnemy.worldY >= remote.cameraY - 24 && localEnemy.worldY <= remote.cameraY + 216;
        const wasKilled =
          localEnemy.spawnId > 0 &&
          Array.isArray(remote.killedSpawnIds) &&
          remote.killedSpawnIds.includes(localEnemy.spawnId);
        if (inHostZone || wasKilled) {
          ram[soa.type + s] = 0;
          ram[soa.flags + s] = 0;
          ram[soa.animId + s] = 0;
          ram[soa.hp + s] = 0;
          ram[0x04f2 + s] = 0xff;
          ram[0x0508 + s] = 0xf0;
          this.prevEnemyType[s] = 0;
          this.prevEnemyHp[s] = 0;
        }
      }
    }
  }

  stepFrame(nowMs = Date.now()) {
    this._ensureCpuHook();
    this._lastStepNowMs = nowMs;
    this.frameCounter++;
    const ram = this.nes.cpu.mem;
    const r = this.profile.ram;
    const soa = r.soa;

    const gameMode = ram[r.gameMode];
    const stageId = ram[r.stageId];
    const roomId = ram[r.roomId];
    const roomKey = (stageId << 8) | roomId;

    for (let s = 0; s < 22; s++) {
      if (this.remoteHitCooldowns[s] > 0) this.remoteHitCooldowns[s]--;
      if (this.localDamageLock[s] > 0) this.localDamageLock[s]--;
    }

    if (gameMode === this.profile.constants.gameModeGameplay) {
      // 1. Check progression unlocks (Suits & Cleared Stages)
      const suits = ram[r.collectedSuitsMask];
      const stages = ram[r.clearedStagesMask];
      if (suits !== this.prevCollectedSuits || stages !== this.prevClearedStages) {
        if ((suits & ~this.prevCollectedSuits) !== 0 || (stages & ~this.prevClearedStages) !== 0) {
          this.outgoingEvents.push({
            type: 'progression',
            collectedSuits: suits,
            clearedStages: stages
          });
        }
        this.prevCollectedSuits = suits;
        this.prevClearedStages = stages;
      }

      // 2. Detect local enemy/boss damage, deaths & P2 lead spawns
      this._detectLocalEnemyChanges(ram);

      // 3. Check if Remote Partner's active projectiles hit any local enemy/boss in the same room
      if (
        this.latestRemoteState &&
        this.latestRemoteState.stageId === stageId &&
        this.latestRemoteState.roomId === roomId &&
        Array.isArray(this.latestRemoteState.projectiles)
      ) {
        const { cameraX, cameraY } = this.getCameraWorld(ram);
        for (const proj of this.latestRemoteState.projectiles) {
          const projScreenX = proj.worldX - cameraX;
          const projScreenY = proj.worldY - cameraY;
          if (projScreenX < 0 || projScreenX >= 256 || projScreenY < 0 || projScreenY >= 192) {
            continue;
          }
          for (let s = soa.enemySlotStart; s < soa.slotCount; s++) {
            if (this.remoteHitCooldowns[s] > 0) continue;
            const eType = ram[soa.type + s];
            const eFlags = ram[soa.flags + s];
            const eHp = ram[soa.hp + s];
            if (eType <= 1 || (eFlags & 0x80) !== 0 || eHp === 0 || eHp === 0xff) continue;
            if (ram[soa.mercyTimer + s] > 0) continue;

            const ex = ram[soa.screenXLo + s];
            const ey = ram[soa.screenYLo + s];
            if (Math.abs(projScreenX - ex) <= 16 && Math.abs(projScreenY - ey) <= 20) {
              const dmg = proj.type >= 2 ? 2 : 1;
              this._applyLocalActorDamage(s, dmg);
              this.remoteHitCooldowns[s] = 12;
            }
          }
        }
      }

      this.prevPlayerHp = ram[soa.hp + 0];

      // 4. If we are Player 2, keep our enemy table locked to Player 1 (Room Host)
      if (this.playerIndex === 2 && this.enableEnemySync !== false) {
        this._syncEnemiesFromHost(nowMs);
      }

      // Save current enemy table state for next frame comparison
      for (let s = soa.enemySlotStart; s < soa.slotCount; s++) {
        this.prevEnemyType[s] = ram[soa.type + s];
        this.prevEnemyHp[s] = ram[soa.hp + s];
      }
      this.prevRoomKey = roomKey;
    }
  }

  _applyLocalActorDamage(slot, damage, forceHpAfter = null, forceKill = false) {
    const ram = this.nes.cpu.mem;
    const soa = this.profile.ram.soa;
    const curType = ram[soa.type + slot];
    const curHp = ram[soa.hp + slot];
    if (curType <= 1 || curHp === 0 || curHp === 0xff) return false;

    const nextHp =
      forceHpAfter !== null ? Math.min(curHp, forceHpAfter) : Math.max(0, curHp - damage);

    if (nextHp <= 0 || forceKill) {
      ram[soa.hp + slot] = 0;
      if (curType < 0x50) {
        ram[soa.type + slot] = 1;
        ram[soa.flags + slot] = 0x80;
        ram[soa.animId + slot] = 0x24;
      } else {
        ram[soa.hp + slot] = 0;
      }
    } else {
      ram[soa.hp + slot] = nextHp;
      ram[soa.mercyTimer + slot] = 6;
    }

    this.prevEnemyHp[slot] = ram[soa.hp + slot];
    this.prevEnemyType[slot] = ram[soa.type + slot];
    return true;
  }

  receiveRemoteState(state, nowMs = Date.now()) {
    if (!state || typeof state !== 'object') return;
    this.lastRemotePacketAt = nowMs;
    this.latestRemoteState = state;
    this.remoteSnapshots.push({ recvAt: nowMs, state });
    if (this.remoteSnapshots.length > 20) {
      this.remoteSnapshots.shift();
    }

    const ram = this.nes.cpu.mem;
    const r = this.profile.ram;
    if (typeof state.collectedSuits === 'number') {
      ram[r.collectedSuitsMask] |= state.collectedSuits;
      this.prevCollectedSuits = ram[r.collectedSuitsMask];
    }
    if (typeof state.clearedStages === 'number') {
      ram[r.clearedStagesMask] |= state.clearedStages;
      this.prevClearedStages = ram[r.clearedStagesMask];
    }
  }

  receiveRemoteEvent(evt) {
    if (!evt || typeof evt !== 'object') return false;
    const ram = this.nes.cpu.mem;
    const r = this.profile.ram;

    if (evt.type === 'progression') {
      if (typeof evt.collectedSuits === 'number') {
        ram[r.collectedSuitsMask] |= evt.collectedSuits;
        this.prevCollectedSuits = ram[r.collectedSuitsMask];
      }
      if (typeof evt.clearedStages === 'number') {
        ram[r.clearedStagesMask] |= evt.clearedStages;
        this.prevClearedStages = ram[r.clearedStagesMask];
      }
      return true;
    }

    if (evt.type === 'actor_damage') {
      const stageId = ram[r.stageId];
      const roomId = ram[r.roomId];
      if (evt.stageId === stageId && evt.roomId === roomId) {
        return this._applyLocalActorDamage(
          evt.slot,
          evt.damage || 1,
          typeof evt.hpAfter === 'number' ? evt.hpAfter : null,
          Boolean(evt.killed)
        );
      }
    }

    if (evt.type === 'actor_spawn' && evt.enemy) {
      const stageId = ram[r.stageId];
      const roomId = ram[r.roomId];
      const soa = r.soa;
      if (evt.stageId === stageId && evt.roomId === roomId) {
        const spawnId = evt.enemy.spawnId;
        if (spawnId > 0) {
          for (let s = soa.enemySlotStart; s < soa.slotCount; s++) {
            if (ram[soa.type + s] !== 0 && ram[0x0484 + s] === spawnId) {
              return false;
            }
          }
        }
        let targetSlot = evt.slot;
        if (ram[soa.type + targetSlot] !== 0) {
          targetSlot = -1;
          for (let s = 14; s < soa.slotCount; s++) {
            if (ram[soa.type + s] === 0) {
              targetSlot = s;
              break;
            }
          }
        }
        if (targetSlot >= soa.enemySlotStart && targetSlot < soa.slotCount) {
          const { cameraX, cameraY, scrollMode } = this.getCameraWorld(ram);
          this._writeEnemySlotToRam(ram, targetSlot, evt.enemy, cameraX, cameraY, scrollMode);
          this.prevEnemyType[targetSlot] = ram[soa.type + targetSlot];
          this.prevEnemyHp[targetSlot] = ram[soa.hp + targetSlot];
          return true;
        }
      }
    }
    return false;
  }

  flushOutgoingEvents() {
    if (this.outgoingEvents.length === 0) return [];
    const evts = this.outgoingEvents.slice();
    this.outgoingEvents.length = 0;
    return evts;
  }

  getInterpolatedRemoteState(nowMs = Date.now()) {
    if (this.remoteSnapshots.length === 0) return null;
    if (nowMs - this.lastRemotePacketAt > 5000) return null;

    const targetTime = nowMs - this.interpDelayMs;
    const snaps = this.remoteSnapshots;

    if (snaps.length === 1 || targetTime <= snaps[0].recvAt) {
      return snaps[0].state;
    }

    const last = snaps[snaps.length - 1];
    if (targetTime >= last.recvAt) {
      return last.state;
    }

    for (let i = 0; i < snaps.length - 1; i++) {
      const s0 = snaps[i];
      const s1 = snaps[i + 1];
      if (targetTime >= s0.recvAt && targetTime <= s1.recvAt) {
        if (
          s0.state.stageId !== s1.state.stageId ||
          s0.state.roomId !== s1.state.roomId
        ) {
          return s1.state;
        }
        const span = Math.max(1, s1.recvAt - s0.recvAt);
        const alpha = Math.max(0, Math.min(1, (targetTime - s0.recvAt) / span));

        let interpEnemies = s1.state.enemies;
        if (Array.isArray(s0.state.enemies) && Array.isArray(s1.state.enemies)) {
          const e0Map = new Map();
          for (const e0 of s0.state.enemies) {
            e0Map.set(e0.slot, e0);
          }
          interpEnemies = s1.state.enemies.map((e1) => {
            const e0 = e0Map.get(e1.slot);
            if (
              e0 &&
              e0.type === e1.type &&
              e0.spawnId === e1.spawnId &&
              Math.abs(e1.worldX - e0.worldX) < 64 &&
              Math.abs(e1.worldY - e0.worldY) < 64
            ) {
              return {
                ...e1,
                worldX: Math.round(e0.worldX + (e1.worldX - e0.worldX) * alpha),
                worldY: Math.round(e0.worldY + (e1.worldY - e0.worldY) * alpha)
              };
            }
            return e1;
          });
        }

        return {
          ...s1.state,
          worldX: Math.round(s0.state.worldX + (s1.state.worldX - s0.state.worldX) * alpha),
          worldY: Math.round(s0.state.worldY + (s1.state.worldY - s0.state.worldY) * alpha),
          enemies: interpEnemies
        };
      }
    }
    return last.state;
  }

  renderCoopOverlay(frameBuffer, nowMs = Date.now()) {
    const result = {
      partnerVisible: false,
      partnerSameRoom: false,
      partnerScreenX: null,
      partnerScreenY: null,
      drawnSprites: 0,
      drawnPixels: 0,
      radarDirection: null
    };

    const remote = this.getInterpolatedRemoteState(nowMs);
    if (!remote) return result;

    const ram = this.nes.cpu.mem;
    const r = this.profile.ram;
    const localGameMode = ram[r.gameMode];
    const validModes = [
      this.profile.constants.gameModeGameplay,
      this.profile.constants.gameModeSuitChange,
      this.profile.constants.gameModePaused
    ];
    if (!validModes.includes(localGameMode)) return result;

    const localStage = ram[r.stageId];
    const localRoom = ram[r.roomId];
    if (remote.stageId !== localStage || remote.roomId !== localRoom) {
      return result;
    }

    result.partnerSameRoom = true;
    const { cameraX, cameraY } = this.getCameraWorld(ram);
    const partnerScreenX = Math.round(remote.worldX - cameraX);
    const partnerScreenY = Math.round(remote.worldY - cameraY);
    result.partnerScreenX = partnerScreenX;
    result.partnerScreenY = partnerScreenY;

    const hudY = this.profile.constants.hudScanlineY; // 192

    if (
      partnerScreenX >= -16 &&
      partnerScreenX < 272 &&
      partnerScreenY >= -16 &&
      partnerScreenY < hudY + 16 &&
      Array.isArray(remote.sprites)
    ) {
      for (const spr of remote.sprites) {
        const sx =
          spr.owner > 0 && typeof spr.worldX === 'number'
            ? Math.round(spr.worldX - cameraX)
            : partnerScreenX + spr.dx;
        const sy =
          spr.owner > 0 && typeof spr.worldY === 'number'
            ? Math.round(spr.worldY - cameraY) + 1
            : partnerScreenY + spr.dy + 1;
        const pixels = this._draw8x16ChrSprite(
          frameBuffer,
          sx,
          sy,
          spr.topChr,
          spr.botChr,
          spr.attr,
          hudY
        );
        if (pixels > 0) {
          result.drawnSprites++;
          result.drawnPixels += pixels;
        }
      }

      if (result.drawnSprites > 0) {
        result.partnerVisible = true;
        const labelX = Math.max(2, Math.min(244, partnerScreenX - 4));
        const labelY = Math.max(2, Math.min(hudY - 8, partnerScreenY - 38));
        this._drawTextBadge(frameBuffer, labelX, labelY, 'P2', 0x50ff50, 0x000000, hudY);
      }
    } else if (this.enableRadar) {
      let rx = Math.max(6, Math.min(234, partnerScreenX));
      let ry = Math.max(6, Math.min(hudY - 10, partnerScreenY - 16));
      let label = 'P2';
      if (partnerScreenX < 0) {
        rx = 4;
        label = '<P2';
        result.radarDirection = 'left';
      } else if (partnerScreenX >= 256) {
        rx = 234;
        label = 'P2>';
        result.radarDirection = 'right';
      } else if (partnerScreenY < 0) {
        ry = 4;
        label = '^P2';
        result.radarDirection = 'up';
      } else {
        ry = hudY - 9;
        label = 'vP2';
        result.radarDirection = 'down';
      }
      this._drawTextBadge(frameBuffer, rx, ry, label, 0x50ff50, 0x000000, hudY);
    }

    return result;
  }

  _draw8x16ChrSprite(frameBuffer, sx, sy, topChr, botChr, attr, maxY) {
    const vromTile = this.nes.rom && this.nes.rom.vromTile;
    if (!vromTile) return 0;

    const hFlip = (attr & 0x40) !== 0;
    const vFlip = (attr & 0x80) !== 0;
    const palIdx = attr & 0x03;

    const topTile = vromTile[topChr >> 8]?.[topChr & 0xff];
    const botTile = botChr >= 0 ? vromTile[botChr >> 8]?.[botChr & 0xff] : null;
    if (!topTile) return 0;

    let drawn = 0;
    const firstTile = vFlip && botTile ? botTile : topTile;
    const secondTile = vFlip && botTile ? topTile : botTile;

    drawn += this._draw8x8Tile(frameBuffer, sx, sy, firstTile, hFlip, vFlip, palIdx, maxY);
    if (secondTile) {
      drawn += this._draw8x8Tile(frameBuffer, sx, sy + 8, secondTile, hFlip, vFlip, palIdx, maxY);
    }
    return drawn;
  }

  _draw8x8Tile(frameBuffer, sx, sy, tileObj, hFlip, vFlip, palIdx, maxY) {
    const pix = tileObj.pix;
    if (!pix) return 0;
    const sprPalette = this.nes.ppu.sprPalette;
    const customPal = this.enableP2Palette ? P2_PALETTE_REMAP[palIdx & 3] : null;

    let count = 0;
    for (let row = 0; row < 8; row++) {
      const py = sy + row;
      if (py < 0 || py >= maxY) continue;
      const srcY = vFlip ? 7 - row : row;
      const rowOffset = py << 8;

      for (let col = 0; col < 8; col++) {
        const px = sx + col;
        if (px < 0 || px >= 256) continue;
        const srcX = hFlip ? 7 - col : col;
        const colorIndex = pix[(srcY << 3) + srcX];
        if (colorIndex === 0) continue;

        const color = customPal
          ? customPal[colorIndex & 3]
          : sprPalette[(palIdx << 2) + (colorIndex & 3)];
        frameBuffer[rowOffset + px] = color;
        count++;
      }
    }
    return count;
  }

  _drawTextBadge(frameBuffer, x, y, text, fgColor, bgColor, maxY) {
    const width = text.length * 5 + 1;
    const height = 7;
    for (let dy = 0; dy < height; dy++) {
      const py = y + dy;
      if (py < 0 || py >= maxY) continue;
      for (let dx = 0; dx < width; dx++) {
        const px = x + dx;
        if (px < 0 || px >= 256) continue;
        frameBuffer[(py << 8) + px] = bgColor;
      }
    }

    let cursorX = x + 1;
    for (const ch of text) {
      const glyph = MINI_GLYPHS[ch];
      if (glyph) {
        for (let gy = 0; gy < glyph.length; gy++) {
          const py = y + 1 + gy;
          if (py < 0 || py >= maxY) continue;
          for (let gx = 0; gx < glyph[gy].length; gx++) {
            if (!glyph[gy][gx]) continue;
            const px = cursorX + gx;
            if (px >= 0 && px < 256) {
              frameBuffer[(py << 8) + px] = fgColor;
            }
          }
        }
      }
      cursorX += 5;
    }
  }

  createWarpSnapshot() {
    const rawState = JSON.parse(JSON.stringify(this.nes.toJSON()));
    return {
      nesState: rawState,
      oamOwner: Array.from(this.oamOwner),
      extracted: this.extractLocalState()
    };
  }

  applyWarpSnapshot(warpData) {
    if (!warpData || !warpData.nesState) return false;
    const ramBefore = this.nes.cpu.mem;
    const r = this.profile.ram;
    const soa = r.soa;

    const myActiveSuit = ramBefore[r.activeSuit];
    const mySuitsMask = ramBefore[r.collectedSuitsMask];
    const myClearedMask = ramBefore[r.clearedStagesMask];
    const myETanks = ramBefore[r.eTanks];
    const myLTanks = ramBefore[r.lTanks];

    const clonedState = JSON.parse(JSON.stringify(warpData.nesState));
    this.nes.fromJSON(clonedState);
    this._ensureCpuHook();
    this.tagRomChrTiles();

    if (Array.isArray(warpData.oamOwner)) {
      for (let i = 0; i < 64; i++) {
        this.oamOwner[i] = warpData.oamOwner[i] ?? -1;
      }
    }

    const ramAfter = this.nes.cpu.mem;
    ramAfter[r.collectedSuitsMask] |= mySuitsMask;
    ramAfter[r.clearedStagesMask] |= myClearedMask;
    ramAfter[r.activeSuit] = myActiveSuit;
    ramAfter[r.eTanks] = Math.max(ramAfter[r.eTanks], myETanks);
    ramAfter[r.lTanks] = Math.max(ramAfter[r.lTanks], myLTanks);
    ramAfter[soa.hp + 0] = Math.max(8, ramAfter[soa.hp + 0]);

    const partnerX = ramAfter[soa.screenXLo + 0];
    ramAfter[soa.screenXLo + 0] = partnerX > 128 ? partnerX - 16 : partnerX + 16;
    ramAfter[soa.mercyTimer + 0] = 60;

    return true;
  }
}
