// Dedicated FIFO Netplay Input Packet Deduplicator & Rx Gap Tracker
const MAX_DEDUP_KEYS = 128;

export function createInputRouter(state) {
  function routeNetplayInput(msg) {
    const firstIn = Array.isArray(msg.inputs) ? msg.inputs[0] : 0;
    const dedupKey = `${msg.sessionId || ''}:${msg.startFrame}:` +
      `${firstIn}:${msg.hashFrame || ''}`;
    let seen = state.rxInputDedupSet;
    if (!seen) seen = state.rxInputDedupSet = new Set();
    if (seen.has(dedupKey)) return false;
    seen.add(dedupKey);
    if (seen.size > MAX_DEDUP_KEYS) seen.delete(seen.keys().next().value);

    state.rxCountThisSec++;
    const nowPerf = performance.now();
    if (state.lastRxInputAt > 0) {
      const gap = Math.round(nowPerf - state.lastRxInputAt);
      if (gap > state.maxRxGapMs && gap < 10000) state.maxRxGapMs = gap;
    }
    state.lastRxInputAt = nowPerf;
    if (state.engine && state.peerConnected) {
      state.engine.receiveRemoteInputPacket(msg, nowPerf);
    }
    return true;
  }

  return { routeNetplayInput };
}
