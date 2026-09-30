// #205: notification tap → open the SyncIndicator sheet. Framework-free bus
// (toastBus.ts / alertBus.ts precedent, zero react imports) so the push
// response handler can request the open from non-React code. SyncIndicator
// registers on mount; a request made before mount (cold start straight from a
// notification tap) is held and delivered once, when the listener registers.

export interface SyncSheetBus {
  requestOpen(): void;
  setListener(fn: (() => void) | null): void;
}

export function createSyncSheetBus(): SyncSheetBus {
  let listener: (() => void) | null = null;
  let pending = false;

  return {
    requestOpen(): void {
      if (listener) listener();
      else pending = true;
    },
    setListener(fn): void {
      listener = fn;
      if (listener && pending) {
        pending = false;
        listener();
      }
    },
  };
}

/** The app-wide bus SyncIndicator subscribes to. */
export const appSyncSheetBus = createSyncSheetBus();
