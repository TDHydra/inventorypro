import { useSyncExternalStore } from 'react';

/**
 * Session-level visibility for the Quick Add banner. Tapping the banner's X hides
 * it everywhere it's shown (dashboard + items list) for the rest of the session;
 * it returns on the next app launch so a hidden banner is never a dead end.
 */
let hidden = false;
const listeners = new Set<() => void>();

export function hideQuickAddBanner(): void {
  if (hidden) return;
  hidden = true;
  listeners.forEach(l => l());
}

export function useQuickAddBannerHidden(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => hidden,
  );
}
