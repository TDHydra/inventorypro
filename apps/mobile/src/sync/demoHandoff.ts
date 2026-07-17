/**
 * Gate for entering a demo/test session while the device still holds unsynced work.
 *
 * A demo session is sandboxed and ends in a full `resetLocalDb()` wipe, so anything
 * left in the outbox when one starts is either destroyed by that wipe or — worse —
 * pushed to the server later under the demo user's JWT. The old rule was a hard
 * block on ANY pending row, which locked the device out of demo accounts entirely
 * once a single entry went dead (attempts >= MAX and no longer sent).
 *
 * The new rule: the audit trail is the only thing that must survive. Push the
 * pending activity_log rows (with the OUTGOING user's JWT — this runs at the
 * picker, before the demo PIN replaces the session); everything else is discarded
 * on demo entry. Block only when the logs genuinely could not be delivered.
 *
 * Pure so it can be tested without op-sqlite/native. Callers inject the real
 * outbox/engine functions.
 */
export type DemoHandoffDeps = {
  /** Rows still awaiting a push, of any table. */
  pendingCount: () => number;
  /** Pushes pending activity_log rows; resolves to how many are STILL undelivered. */
  pushLogs: () => Promise<number>;
};

export type DemoHandoffResult = { ok: boolean; stuckLogs: number };

export async function prepareForDemoLogin(deps: DemoHandoffDeps): Promise<DemoHandoffResult> {
  if (deps.pendingCount() === 0) return { ok: true, stuckLogs: 0 };

  let stuckLogs: number;
  try {
    stuckLogs = await deps.pushLogs();
  } catch {
    // Offline, or the push threw. We cannot prove the logs landed, and a demo
    // session would erase them — treat an unknown outcome as undelivered.
    stuckLogs = 1;
  }

  return { ok: stuckLogs === 0, stuckLogs };
}
