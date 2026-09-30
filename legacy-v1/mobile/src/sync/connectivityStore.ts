// #215 feedback: one reactive connectivity snapshot for the app shell, instead
// of every consumer holding its own NetInfo listener. Framework-free (the
// toastBus/offlineSaveToast precedent) so the merge rules run under node:test;
// installConnectivityMonitor.ts is the NetInfo/AppState glue that feeds it.
//
// Two inputs, one rule each:
//  - NetInfo reports (events + the monitor's fast poll): `true`/`false` apply
//    as-is; `null` ("unknown") is ignored once we know anything — unknown must
//    never clobber a definite state (the tri-state rule OfflineBanner has
//    always used, hoisted here).
//  - A completed sync pull (`noteServerReachable`): forces `true`. NetInfo
//    false-negatives on some Android networks/VPNs (see engine.ts) — a
//    successful server round-trip is ground truth that we are online. There is
//    deliberately NO failure counterpart: a failed request while NetInfo says
//    online usually means the SERVER is unreachable, not the network, and
//    "Working offline" would flash on/off every retry cycle.

let isConnected: boolean | null = null;
const listeners = new Set<() => void>();

function set(next: boolean | null): void {
  if (next === isConnected) return;
  isConnected = next;
  for (const fn of listeners) fn();
}

/** Feed a NetInfo report (event or poll). `null` never clobbers a known state. */
export function noteNetInfoState(state: boolean | null): void {
  if (state === null && isConnected !== null) return;
  set(state);
}

/** A sync pull completed — we are definitely online, whatever NetInfo thinks. */
export function noteServerReachable(): void {
  set(true);
}

/** Snapshot for useSyncExternalStore. Tri-state: null = not yet known. */
export function getConnectivity(): boolean | null {
  return isConnected;
}

export function subscribeConnectivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The banner/toast rule: only a definite `false` counts as offline. */
export function isDefinitelyOffline(): boolean {
  return isConnected === false;
}

/** Test-only: reset module state between node:test cases. */
export function resetConnectivityForTest(): void {
  isConnected = null;
  listeners.clear();
}
