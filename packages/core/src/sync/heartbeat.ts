// #236: fleet sync-health heartbeat — pure gate/throttle logic, kept out of
// engine.ts so it's testable under plain node:test (engine.ts pulls in the
// full sync stack). engine.ts owns the module-level lastHeartbeatAt/
// lastCountsNonzero state and the single track()/getOutboxCounts() call site.

export const HEARTBEAT_INTERVAL_MS = 30 * 60_000; // 30 minutes

export interface OutboxHeartbeatCounts {
  pending: number;
  failed: number;
  denied: number;
}

// Decides whether this sync cycle should emit an 'outbox_heartbeat' telemetry
// event. Two rules, in order:
//
// 1. Any count > 0: emit, but throttled to at most once per
//    HEARTBEAT_INTERVAL_MS (lastMs === null means "never emitted" -> emit
//    immediately). A persistently nonzero outbox is the interesting signal
//    (fleet-wide stuck/failed/denied backlog) and repeating it every cycle
//    would just be noise.
// 2. All counts === 0: normally silent (nothing wrong to report), EXCEPT the
//    cycle right after a nonzero emit — that return-to-zero is itself a
//    signal (recovered) and fires immediately, ignoring the throttle window,
//    so the fleet view isn't left showing a stale nonzero heartbeat as the
//    device's last-known state. `lastCountsWereNonzero` is the caller's
//    record of whether the PREVIOUS emitted heartbeat (if any) was nonzero.
export function shouldEmitHeartbeat(
  nowMs: number,
  lastMs: number | null,
  counts: OutboxHeartbeatCounts,
  lastCountsWereNonzero = false
): boolean {
  const anyNonzero = counts.pending > 0 || counts.failed > 0 || counts.denied > 0;

  if (anyNonzero) {
    if (lastMs === null) return true;
    return nowMs - lastMs >= HEARTBEAT_INTERVAL_MS;
  }

  // All-zero: only worth a heartbeat if it's the transition off a nonzero
  // state — otherwise there's nothing new to say.
  return lastCountsWereNonzero;
}
