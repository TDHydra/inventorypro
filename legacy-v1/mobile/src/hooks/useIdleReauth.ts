import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { createIdleTimer, IdleTimer } from './idleTimerCore';
import { checkReauthDue, touchReauthActivity } from '../auth/reauthTracker';

/**
 * Per-role idle re-auth (#244 / idea 31). Combines two mechanisms, per the
 * architect correction in reauthCore.ts's header comment:
 *
 *  (a) A reused foreground `idleTimerCore` instance — catches "left the app
 *      open on screen and walked away without backgrounding it" via the same
 *      countdown-since-last-touch primitive `useIdleLogout` uses.
 *  (b) An AppState→active elapsed-time check against the device-local
 *      `idle_reauth_last_active_at` stamp — catches "phone sat idle in a
 *      pocket/drawer", which (a) alone can never see (its setTimeout doesn't
 *      run while the app is suspended).
 *
 * Either one raises the gate (`requireReauth()`, in reauthGate.ts); only a
 * successful PIN re-entry lowers it. `minutes` is read fresh on every arm
 * (mirrors useIdleLogout) so an admin changing the role's setting mid-session
 * takes effect on the caller's next touch/foreground, same convention as the
 * org-wide idle-logout setting.
 */
export function useIdleReauth(minutes: number): { touch: () => void } {
  const minutesRef = useRef(minutes);
  useEffect(() => { minutesRef.current = minutes; }, [minutes]);

  const timerRef = useRef<IdleTimer | null>(null);

  useEffect(() => {
    const timer = createIdleTimer({
      getMinutes: () => minutesRef.current,
      onTimeout: () => {
        // Re-check via checkReauthDue (not a bare requireReauth()) so a stamp
        // refreshed by some OTHER path in the same tick (e.g. a touch that
        // raced the timeout) isn't second-guessed — checkReauthDue no-ops
        // when the setting is disabled, matching the AppState path exactly.
        checkReauthDue(minutesRef.current);
      },
    });
    timerRef.current = timer;
    timer.arm();

    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        checkReauthDue(minutesRef.current);
        timer.arm();
      }
    });

    return () => {
      sub.remove();
      timer.dispose();
      timerRef.current = null;
    };
  }, []);

  return {
    touch: () => {
      touchReauthActivity();
      timerRef.current?.arm();
    },
  };
}
