// #205: decision logic for the "changes couldn't sync" self-notification.
// Framework-free (no expo/db imports, toastBus.ts precedent) so it is
// unit-testable under node:test; the localAlerts twins own the side effects
// (scheduleNotificationAsync / new Notification + the app_settings dedup key).
//
// Unlike the per-entity alert prefixes, this is a single aggregate alert: fire
// once when the failed (retry-exhausted) bucket becomes non-empty, stay quiet
// while it is outstanding, and clear the dedup key when every failure has
// recovered (retried away or discarded) so a later failure can re-fire.

export const SYNC_STUCK_KEY = 'alert:sync_stuck';

export interface SyncStuckDecision {
  action: 'notify' | 'clear' | 'none';
  body?: string;
}

export function evaluateSyncStuckAlert(
  failedCount: number,
  alreadyNotified: boolean
): SyncStuckDecision {
  if (failedCount > 0 && !alreadyNotified) {
    const noun = failedCount === 1 ? 'change' : 'changes';
    return {
      action: 'notify',
      body: `${failedCount} ${noun} couldn't sync — tap to review and retry`,
    };
  }
  if (failedCount === 0 && alreadyNotified) return { action: 'clear' };
  return { action: 'none' };
}
