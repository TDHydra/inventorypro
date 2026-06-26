import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { getIdleTimeoutMinutes } from '../db/appSettings';

/**
 * Idle auto-logout hook.
 *
 * Reads `idle_timeout_minutes` from `app_settings` on every timer arm (mount,
 * AppState→active, and explicit `reset()` calls) so changes to the setting
 * take effect on the next touch or foreground event.
 *
 * When minutes > 0, a `setTimeout(logout, mins * 60_000)` runs and resets on
 * each `reset()` or foreground event.  When minutes === 0, the hook is a no-op.
 *
 * @param logout  The session-context logout function (clearSession + setUser(null))
 * @returns       `{ reset }` — call on every user touch to restart the timer
 */
export function useIdleLogout(logout: () => Promise<void>): { reset: () => void } {
  // Keep a stable ref to logout so the timer callback always sees the latest one
  const logoutRef = useRef(logout);
  useEffect(() => {
    logoutRef.current = logout;
  }, [logout]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armTimer = useCallback(() => {
    // Clear any existing timer first
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const mins = getIdleTimeoutMinutes();
    if (mins <= 0) return; // disabled
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void logoutRef.current();
    }, mins * 60_000);
  }, []);

  const reset = armTimer;

  useEffect(() => {
    // Arm on mount
    armTimer();

    // Re-arm whenever the app returns to the foreground
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        armTimer();
      }
    });

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      sub.remove();
    };
  }, [armTimer]);

  return { reset };
}
