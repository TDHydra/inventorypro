// #218: "Saved — will sync when back online" confirmation for offline writes.
// Framework-free factory (toastBus/confirmQueue precedent) so the decision
// rules run under plain node:test. Fed COMMITTED outbox-append notifications
// (the 'outbox' table bump appendOutbox queues — deferred to COMMIT by
// queueTableBump, so a rolled-back transaction never toasts) and decides when
// a toast is warranted:
//   - only while definitively offline (the caller's isOffline mirrors
//     OfflineBanner's "only a definite false" NetInfo rule)
//   - collapsed by a cooldown so a multi-save flow (checkout after checkout)
//     confirms once, not once per row.

export interface OfflineSaveToasterOpts {
  isOffline: () => boolean;
  toast: (message: string, action: { label: string; onPress: () => void }) => void;
  /** Opens the sync detail (SyncIndicator sheet via appSyncSheetBus). */
  onView: () => void;
  coolDownMs?: number;
  now?: () => number;
}

export function createOfflineSaveToaster(opts: OfflineSaveToasterOpts): { noteOutboxChange(): void } {
  const coolDownMs = opts.coolDownMs ?? 5000;
  const now = opts.now ?? Date.now;
  let lastToastAt = -Infinity;

  return {
    noteOutboxChange(): void {
      if (!opts.isOffline()) return;
      const t = now();
      if (t - lastToastAt <= coolDownMs) return;
      lastToastAt = t;
      opts.toast('Saved — will sync when back online', { label: 'View', onPress: opts.onView });
    },
  };
}
