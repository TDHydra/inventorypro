// #215: pure banner-state decision for OfflineBanner — framework-free (the
// toastBus precedent) so the show/hide + wording rules are unit-testable.
//
// `isConnected` is NetInfo's tri-state: null means "unknown" (NetInfo can
// false-negative on some Android networks/VPNs — see sync/engine.ts), so ONLY
// a definite `false` shows the banner; unknown stays quiet rather than crying
// wolf on a working connection.
export function evaluateOfflineBanner(
  isConnected: boolean | null,
  queuedCount: number,
): string | null {
  if (isConnected !== false) return null;
  if (queuedCount <= 0) return 'Working offline — changes will be saved and queued';
  const noun = queuedCount === 1 ? 'change' : 'changes';
  return `Working offline — ${queuedCount} ${noun} queued`;
}
