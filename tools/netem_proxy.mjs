// Realistic SG-RU Pinggy TCP/HTTP/WS Network Emulator Proxy (FIFO + Cap)
import net from 'net';

export function startNetemProxy(targetPort, initialOpts = {}) {
  let cfg = {
    rttMs: 0,
    jitterMs: 0,
    kbpsCap: 0,
    clumpEveryMs: 0,
    clumpHoldMs: 0,
    ...initialOpts
  };
  let bytesUp = 0, bytesDown = 0, maxQueueMs = 0;
  let nextTokenAt = 0;
  let seq = 0;
  const openSockets = new Set();

  function deterministicJitter() {
    if (!(cfg.jitterMs > 0)) return 0;
    seq = (seq * 1664525 + 1013904223) >>> 0;
    const u = (seq / 0xffffffff) * 2 - 1;
    return Math.round(u * cfg.jitterMs * 0.5);
  }

  function scheduleChunk(srcSock, dstSock, chunk, isUp) {
    if (isUp) bytesUp += chunk.length;
    else bytesDown += chunk.length;
    const now = performance.now();
    const oneWay = Math.max(0, Math.round((cfg.rttMs || 0) * 0.5));
    const jit = deterministicJitter();
    let clump = 0;
    if (cfg.clumpEveryMs > 0 && cfg.clumpHoldMs > 0) {
      const phase = now % cfg.clumpEveryMs;
      if (phase < cfg.clumpHoldMs) clump = cfg.clumpHoldMs - phase;
    }
    let capReadyAt = now;
    if (cfg.kbpsCap > 0) {
      const txMs = (chunk.length / (cfg.kbpsCap * 1024)) * 1000;
      nextTokenAt = Math.max(now, nextTokenAt) + txMs;
      capReadyAt = nextTokenAt;
    }
    const rawTarget = Math.max(now, capReadyAt) + oneWay + jit + clump;
    const prevAt = srcSock._lastDeliverAt || 0;
    const deliverAt = Math.max(prevAt, rawTarget);
    srcSock._lastDeliverAt = deliverAt;
    const delayMs = Math.max(0, Math.round(deliverAt - now));
    if (delayMs > maxQueueMs) maxQueueMs = delayMs;

    if (delayMs === 0) {
      if (!dstSock.destroyed) dstSock.write(chunk);
      return;
    }
    const t = setTimeout(() => {
      if (!dstSock.destroyed) dstSock.write(chunk);
    }, delayMs);
    t.unref?.();
  }

  return new Promise((resolve, reject) => {
    const srv = net.createServer((client) => {
      client.setNoDelay(true);
      const upstream = net.connect(targetPort, '127.0.0.1');
      upstream.setNoDelay(true);
      openSockets.add(client);
      openSockets.add(upstream);
      const cleanup = () => {
        openSockets.delete(client);
        openSockets.delete(upstream);
        if (!client.destroyed) client.destroy();
        if (!upstream.destroyed) upstream.destroy();
      };
      client.on('error', cleanup);
      upstream.on('error', cleanup);
      client.on('close', cleanup);
      upstream.on('close', cleanup);
      client.on('data', (c) => scheduleChunk(client, upstream, c, true));
      upstream.on('data', (c) => scheduleChunk(upstream, client, c, false));
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.2', () => {
      resolve({
        port: srv.address().port,
        setProfile(next) { cfg = { ...cfg, ...next }; },
        resetStats() { bytesUp = 0; bytesDown = 0; maxQueueMs = 0; },
        getStats() { return { bytesUp, bytesDown, maxQueueMs }; },
        close() {
          for (const s of openSockets) { try { s.destroy(); } catch {} }
          openSockets.clear();
          return new Promise((r) => srv.close(() => r()));
        }
      });
    });
  });
}
