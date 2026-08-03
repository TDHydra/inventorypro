import { useSyncExternalStore } from 'react';

/**
 * Session-level "the per-role idle re-auth gate is up" flag (#244 / idea 31).
 * A plain module-level boolean + subscriber set — mirrors the minimal
 * `quickAddBanner.ts` pattern — so `app/(app)/_layout.tsx`'s `ReauthGate`
 * modal re-renders the instant `requireReauth()` fires (AppState resume or
 * the reused foreground idle timer), without any polling. Satisfies the
 * "module caches that gate UI must notify subscribers" house rule.
 */
let required = false;
const listeners = new Set<() => void>();

function setRequired(next: boolean): void {
  if (required === next) return;
  required = next;
  listeners.forEach(l => l());
}

/** Raise the gate — called from the idle-reauth timer/AppState check. */
export function requireReauth(): void {
  setRequired(true);
}

/** Lower the gate — called after a successful PIN re-entry. */
export function clearReauthRequired(): void {
  setRequired(false);
}

export function isReauthRequired(): boolean {
  return required;
}

export function useReauthRequired(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => required,
  );
}
