import { subscribeTables } from './dataVersion';
import { appToastBus } from '../lib/toastBus';
import { appSyncSheetBus } from '../components/syncSheetBus';
import { createOfflineSaveToaster } from './offlineSaveToast';
import { isDefinitelyOffline } from './connectivityStore';

// #218: glue between the pure toaster (offlineSaveToast.ts) and the app —
// installed once at the root layout next to startSyncEngine, lives for the
// app's lifetime (like the engine, never uninstalled).

let installed = false;

export function installOfflineSaveToast(): void {
  if (installed) return;
  installed = true;

  const toaster = createOfflineSaveToaster({
    // connectivityStore keeps the "only a definite false" tri-state rule this
    // used to enforce with its own NetInfo listener.
    isOffline: isDefinitelyOffline,
    // tone: the on-device feedback on #218 was that the default dark strip is
    // easy to miss — the success tone renders it as a bold green banner.
    toast: (message, action) => appToastBus.push({ message, action, tone: 'success' }),
    onView: () => appSyncSheetBus.requestOpen(),
  });

  // Fires on COMMIT of any transaction that appended outbox entries — see the
  // 'outbox' queueTableBump in outbox.ts.
  subscribeTables(['outbox'], () => toaster.noteOutboxChange());
}
