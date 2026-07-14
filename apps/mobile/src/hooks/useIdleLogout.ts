import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { getIdleTimeoutMinutes } from '../db/appSettings';
import { createIdleTimer, IdleTimer } from './idleTimerCore';

/**
 * Idle auto-logout hook.
 *
 * Reads `idle_timeout_minutes` from `app_settings` on every timer arm (mount,
 * AppState→active, and explicit `reset()` calls) so changes to the setting
 * take effect on the next touch or foreground event. When the effective
 * minutes are 0, the hook is a no-op. Timer semantics live in
 * `idleTimerCore.ts` (unit-tested).
 *
 * @param logout  The session-context logout function (clearSession + setUser(null))
 * @param opts.overrideMinutes  Forces the timeout regardless of the setting —
 *                              test/demo sessions pin this to 15 (works even
 *                              when the admin setting disables idle logout).
 * @param opts.onWarn  Fired 60s before logout (skipped for timeouts ≤90s) —
 *                     the "Still there?" nudge hangs off this.
 * @returns `{ reset }` — call on every user touch to restart the timer
 */
export interface IdleLogoutOptions {
  overrideMinutes?: number;
  onWarn?: () => void;
}

export function useIdleLogout(
  logout: () => Promise<void>,
  opts?: IdleLogoutOptions,
): { reset: () => void } {
  // Stable refs so the timer callbacks always see the latest closures
  const logoutRef = useRef(logout);
  const onWarnRef = useRef(opts?.onWarn);
  useEffect(() => {
    logoutRef.current = logout;
    onWarnRef.current = opts?.onWarn;
  });

  const timerRef = useRef<IdleTimer | null>(null);
  const reset = useCallback(() => {
    timerRef.current?.arm();
  }, []);

  const overrideMinutes = opts?.overrideMinutes;
  useEffect(() => {
    const timer = createIdleTimer({
      getMinutes: getIdleTimeoutMinutes,
      overrideMinutes,
      onTimeout: () => {
        void logoutRef.current();
      },
      onWarn: () => {
        onWarnRef.current?.();
      },
    });
    timerRef.current = timer;

    // Arm on mount; re-arm whenever the app returns to the foreground
    timer.arm();
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        timer.arm();
      }
    });

    return () => {
      sub.remove();
      timer.dispose();
      timerRef.current = null;
    };
  }, [overrideMinutes]);

  return { reset };
}
