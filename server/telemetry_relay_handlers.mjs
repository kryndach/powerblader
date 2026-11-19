// WebSocket Autotest & Live Gameplay Telemetry Persistence Handlers
export function handleAutotestReportWs(
  peer, msg, trackers, options, sendToPeer, broadcastToRoom
) {
  const { autotestSession, saveAutotestReportToDisk } = trackers;
  const pIdx = msg.report.playerIndex || peer.playerIndex || 1;
  if (pIdx === 2) autotestSession.pc2 = msg.report;
  else autotestSession.pc1 = msg.report;
  saveAutotestReportToDisk();
  if (msg.report.isFinal && options.logAccess !== false) {
    console.log(
      `[AUTOTEST] Saved final report from PC ${pIdx}` +
        ' to logs/autotest_latest.txt'
    );
  }
  const syncMsg = {
    type: 'autotest_combined_text',
    combinedText: autotestSession.combinedText
  };
  if (msg.report.isFinal) {
    sendToPeer(peer, syncMsg);
    broadcastToRoom(peer.roomCode, peer.clientId, syncMsg);
  } else if (peer.playerIndex === 1) {
    sendToPeer(peer, syncMsg);
  }
}

export function handleGameplayTelemetryWs(peer, msg, trackers) {
  const { gameplayTelemetrySession, saveGameplayTelemetryToDisk } = trackers;
  const telObj = msg.telemetry || msg.payload;
  const pIdx = telObj.playerIndex || peer.playerIndex || 1;
  if (pIdx === 2) gameplayTelemetrySession.pc2 = telObj;
  else gameplayTelemetrySession.pc1 = telObj;
  saveGameplayTelemetryToDisk();
}
