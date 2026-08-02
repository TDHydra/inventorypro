import NetInfo from './netinfo';
import { subscribeTables } from './dataVersion';
import { appToastBus } from '../lib/toastBus';
import { appSyncSheetBus } from '../components/syncSheetBus';
import { createOfflineSaveToaster } from './offlineSaveToast';

// #218: glue between the pure toaster (offlineSaveToast.ts) and the app —
// installed once at the root layout next to startSyncEngine, lives for the
// app's lifetime (like the engine, never uninstalled).

let installed = false;

export function installOfflineSaveToast(): void {
  if (installed) return;
  installed = true;

  // Same tri-state rule as OfflineBanner: only a definite `false` counts as
  // offline (NetInfo false-negatives on some Android networks — engine.ts).
  let offline = false;
  NetInfo.addEventListener(state => {
    offline = state.isConnected === false;
  });

  const toaster = createOfflineSaveToaster({
    isOffline: () => offline,
    toast: (message, action) => appToastBus.push({ message, action }),
    onView: () => appSyncSheetBus.requestOpen(),
  });

  // Fires on COMMIT of any transaction that appended outbox entries — see the
  // 'outbox' queueTableBump in outbox.ts.
  subscribeTables(['outbox'], () => toaster.noteOutboxChange());
}
