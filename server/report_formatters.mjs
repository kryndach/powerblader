// Server Telemetry, AutoTest Report Formatters & Access Log Tracker
import fs from 'fs';
import path from 'path';

const DIVIDER = '='.repeat(68);

export function createSessionTrackers(rootDir, options = {}) {
  const accessLog = [];
  const tunnelInfo = {
    tunnel: process.env.TUNNEL_PROVIDER || 'unknown',
    region: process.env.TUNNEL_REGION || 'auto',
    publicUrl: null,
    updatedAt: null
  };
  const autotestSession = {
    startedAt: new Date().toISOString(),
    updatedAt: null,
    tunnelInfo,
    pc1: null,
    pc2: null,
    combinedText: ''
  };
  const gameplayTelemetrySession = {
    startedAt: new Date().toISOString(),
    updatedAt: null,
    tunnelInfo,
    pc1: null,
    pc2: null,
    combinedText: ''
  };

  function ensureLogsDir() {
    const logsDir = options.logsDir || path.join(rootDir, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    return logsDir;
  }

  function recordAccess(req, note) {
    const xff =
      req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const host = req.headers['host'] || 'localhost';
    const ua = (req.headers['user-agent'] || '').slice(0, 65);
    const entry = {
      ts: new Date().toISOString().slice(11, 23),
      note,
      host,
      ip: String(xff).split(',')[0].trim(),
      ua
    };
    accessLog.push(entry);
    if (accessLog.length > 30) accessLog.shift();
    if (options.logAccess !== false) {
      console.log(`[${entry.ts}] ${note} | host=${host} | ip=${entry.ip}`);
    }
  }

  function saveGameplayTelemetryToDisk() {
    try {
      const logsDir = ensureLogsDir();
      gameplayTelemetrySession.updatedAt = new Date().toISOString();
      const tUrl = tunnelInfo.publicUrl || '--';
      const tHdr =
        `   Tunnel: ${tunnelInfo.tunnel} (Region: ${tunnelInfo.region})` +
        ` | Public URL: ${tUrl}`;
      const lines = [
        DIVIDER,
        '   2-PC LIVE NES GAMEPLAY & NETCODE TELEMETRY REPORT',
        `   Updated: ${gameplayTelemetrySession.updatedAt}`,
        tHdr,
        DIVIDER
      ];

      for (const [label, pc] of [
        ['PC 1 (HOST)', gameplayTelemetrySession.pc1],
        ['PC 2 (GUEST)', gameplayTelemetrySession.pc2]
      ]) {
        lines.push(`\n--- ${label} ---`);
        if (!pc) {
          lines.push('  (No gameplay telemetry received from this PC yet)');
          continue;
        }
        lines.push(
          `  Room: ${pc.roomCode || '--'} | Role: P${pc.playerIndex || '--'}` +
            ` | Transport: ${pc.transport || '--'}`
        );
        lines.push(
          `  ROM: ${pc.romName || 'None'} [CRC32: ${pc.romCrc32 || '--'}]` +
            ` | Partner ROM CRC32: ${pc.partnerRomCrc32 || '--'}`
        );
        lines.push(
          `  Match State: ${pc.matchState || '--'}` +
            ` | Frame: ${pc.currentFrame ?? 0}` +
            ` | Verified Frame: ${pc.lastVerifiedFrame ?? '--'}` +
            ` | Sync: ${pc.syncStatus || '--'}` +
            ` (Desyncs: ${pc.desyncCount ?? 0})`
        );
        lines.push(
          `  Ping RTT: ${pc.rttMs ?? '--'} ms` +
            ` (Jitter: +/-${pc.jitterMs ?? 0} ms)` +
            ` | Clock Rift: ${pc.riftFrames ?? 0}f` +
            ` | Input Delay: ${pc.inputDelayFrames ?? '--'}f`
        );
        lines.push(
          `  FPS: ${pc.fps ?? '--'}` +
            ` | Step Time: ${pc.lastStepMs ?? '--'} ms/f` +
            ` | Rollbacks: ${pc.rollbacksPerSec ?? 0}/s` +
            ` (Total: ${pc.rollbacksTotal ?? 0},` +
            ` Last/Max Depth: ${pc.lastRollbackDepth ?? 0}f/` +
            `${pc.maxRollbackDepthSeen ?? 0}f)`
        );
        lines.push(
          `  Frame Advantage: ${pc.frameAdvantage ?? 0}f` +
            ` | Rift Stalls: ${pc.stallFrames ?? 0}` +
            ` | Rift Pacing Waits: ${pc.riftWaitFrames ?? 0}` +
            ` | Packet Rate: Tx ${pc.txPerSec ?? 0}/s,` +
            ` Rx ${pc.rxPerSec ?? 0}/s` +
            ` (Max Rx Gap: ${pc.maxRxGapMs ?? 0}ms)`
        );

        if (Array.isArray(pc.samples) && pc.samples.length > 0) {
          lines.push('  Recent 2s Telemetry Samples (Chronological):');
          for (const s of pc.samples.slice(-25)) {
            lines.push(
              `    [${s.ts}] f=${s.frame} | FPS=${s.fps} | RTT=${s.rtt}ms` +
                ` | Rift=${s.rift}f | Adv=${s.adv}f` +
                ` | RB=${s.rbSec}/s (max=${s.maxRb}f)` +
                ` | Stalls=${s.stalls} | Step=${s.stepMs}ms` +
                ` | Tx/Rx=${s.tx}/${s.rx} (MaxGap=${s.maxGap}ms) | ${s.sync}`
            );
          }
        }
        if (Array.isArray(pc.events) && pc.events.length > 0) {
          lines.push('  Recent Gameplay & Sync Events:');
          for (const ev of pc.events.slice(-25)) {
            lines.push(`    ${ev}`);
          }
        }
      }

      lines.push(`\n${DIVIDER}\n`);
      gameplayTelemetrySession.combinedText = lines.join('\n');
      fs.writeFileSync(
        path.join(logsDir, 'gameplay_telemetry_latest.json'),
        JSON.stringify(gameplayTelemetrySession, null, 2),
        'utf8'
      );
      fs.writeFileSync(
        path.join(logsDir, 'gameplay_telemetry_latest.txt'),
        gameplayTelemetrySession.combinedText,
        'utf8'
      );
    } catch (e) {
      if (options.logAccess !== false) {
        console.error('Failed saving gameplay telemetry:', e.message);
      }
    }
  }

  function saveAutotestReportToDisk() {
    try {
      const logsDir = ensureLogsDir();
      autotestSession.updatedAt = new Date().toISOString();
      const tUrl = tunnelInfo.publicUrl || '--';
      const tHdr =
        `   Tunnel: ${tunnelInfo.tunnel} (Region: ${tunnelInfo.region})` +
        ` | Public URL: ${tUrl}`;
      const lines = [
        DIVIDER,
        '   2-PC AUTOMATED NETWORK, P2P & PROTOCOL BENCHMARK REPORT',
        `   Updated: ${autotestSession.updatedAt}`,
        tHdr,
        DIVIDER
      ];

      for (const [label, pc] of [
        ['PC 1 (HOST)', autotestSession.pc1],
        ['PC 2 (GUEST)', autotestSession.pc2]
      ]) {
        lines.push(`\n--- ${label} ---`);
        if (!pc) {
          lines.push('  (No report received from this PC yet)');
          continue;
        }
        lines.push(`  URL: ${pc.url || '--'} | UA: ${pc.userAgent || '--'}`);
        lines.push(
          `  Stage Status: ${pc.overallStatus || '--'}` +
            ` | Active Transport: ${pc.activeTransport || '--'}` +
            ` | Dual-WS: ${pc.dualWsOk ? 'BOUND' : 'SINGLE'}`
        );
        lines.push(
          `  Server RTT: ${pc.serverRttMs ?? '--'} ms` +
            ` | WSS Peer RTT: ${pc.wssRttMs ?? '--'} ms` +
            ` (Jitter: +/-${pc.wssJitterMs ?? 0}ms)`
        );
        lines.push(
          `  WebRTC Fast UDP RTT: ${pc.rtcFastRttMs ?? 'BLOCKED'} ms` +
            ` | WebRTC Reliable RTT: ${pc.rtcRelRttMs ?? 'BLOCKED'} ms`
        );
        if (pc.httpBench) {
          const hb = pc.httpBench;
          lines.push(
            `  Striped HTTP (/api/room-rom ${hb.payloadKb || 512}KB): ` +
              `1x=${hb.singleDlKbps} KB/s | 8x=${hb.stripeDlKbps} KB/s ` +
              `(${hb.speedup}x) | PC2-UL=${hb.pc2UploadKbps} KB/s | ` +
              `1stPct=DL:${hb.firstDlPct}%/UL:${hb.firstUlPct}% | ` +
              `CRC=${hb.crcOk ? 'OK' : 'FAIL'}`
          );
        }
        if (pc.wasmBench) {
          const wb = pc.wasmBench;
          const p1 = wb.pc1 || {}, p2 = wb.pc2 || {};
          lines.push(
            `  Arcade WASM (FBNeo): Hash60=${wb.hashMatch ? 'MATCH' : 'DIFF'}` +
              ` (${p1.hash60 || '--'}) | PC1 5f-RB=${p1.rb5Ms ?? '--'}ms` +
              ` (Boot=${p1.bootMs ?? '--'}ms) | PC2 5f-RB=${p2.rb5Ms ?? '--'}` +
              `ms (Boot=${p2.bootMs ?? '--'}ms)`
          );
        }
        if (pc.liveNetplay) {
          const ln = pc.liveNetplay;
          lines.push(
            `  Live 2-PC Netplay (${ln.frames}f + 4x + Sync): ` +
              `Hash=${ln.hashMatch ? 'SYNC_OK' : 'DESYNC'} (${ln.pc1Hash}) | ` +
              `Desyncs=${ln.pc1Desyncs}/${ln.pc2Desyncs} | ` +
              `RB=${ln.pc1Rollbacks}/${ln.pc2Rollbacks} | ` +
              `SyncLoad=${ln.syncImportOk ? 'OK' : 'FAIL'}`
          );
        }
        if (Array.isArray(pc.stages) && pc.stages.length > 0) {
          lines.push('  Benchmark Stages:');
          for (const s of pc.stages) {
            lines.push(`    - [${s.status}] ${s.name}: ${s.summary}`);
          }
        }
        if (Array.isArray(pc.webrtcProfiles) && pc.webrtcProfiles.length > 0) {
          lines.push('  WebRTC P2P & STUN/TURN Profile Matrix:');
          for (const p of pc.webrtcProfiles) {
            const loc = (p.localTypes || []).join(',');
            const rem = (p.remoteTypes || []).join(',');
            const tag = p.open ? 'OPEN' : 'BLOCKED';
            lines.push(
              `    - [${tag}] ${p.name}: ICE=${p.iceState},` +
                ` LocalCand=[${loc}], RemoteCand=[${rem}],` +
                ` Pair=${p.selectedPair || 'none'}, RTT=${p.rttMs ?? '--'}ms`
            );
          }
        }
        if (Array.isArray(pc.logs) && pc.logs.length > 0) {
          lines.push('  Recent Event Log (Chronological):');
          for (const l of pc.logs.slice(-35)) {
            lines.push(`    ${l}`);
          }
        }
      }

      const rec =
        autotestSession.pc1?.recommendations ||
        autotestSession.pc2?.recommendations;
      if (rec) {
        lines.push('\n--- AUTO-TUNED NETPLAY RECOMMENDATIONS ---');
        lines.push(`  Preferred Transport: ${rec.transport}`);
        lines.push(
          `  Recommended Input Delay: NES=${rec.nesDelayFrames}f` +
            ` | Arcade=${rec.arcadeDelayFrames}f`
        );
        const cpuTag = rec.cpu60FpsOk
          ? 'PASS (Both PCs < 16.7ms)' : 'WARN (Heavy CPU)';
        lines.push(`  60fps 5f-Rollback Headroom: ${cpuTag}`);
      }

      lines.push('\n--- RECENT SERVER ACCESS LOG ---');
      for (const a of accessLog.slice(-15)) {
        lines.push(`  [${a.ts}] ${a.note} | host=${a.host} | ip=${a.ip}`);
      }
      lines.push(`${DIVIDER}\n`);

      autotestSession.combinedText = lines.join('\n');
      fs.writeFileSync(
        path.join(logsDir, 'autotest_latest.json'),
        JSON.stringify(autotestSession, null, 2),
        'utf8'
      );
      fs.writeFileSync(
        path.join(logsDir, 'autotest_latest.txt'),
        autotestSession.combinedText,
        'utf8'
      );
    } catch (e) {
      if (options.logAccess !== false) {
        console.error('Failed saving autotest report:', e.message);
      }
    }
  }

  return {
    accessLog,
    tunnelInfo,
    autotestSession,
    gameplayTelemetrySession,
    recordAccess,
    saveGameplayTelemetryToDisk,
    saveAutotestReportToDisk
  };
}
