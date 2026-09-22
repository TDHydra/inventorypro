/**
 * Pure timer core behind `useIdleLogout` — extracted so the arm/warn/timeout
 * logic is unit-testable without React or React Native.
 *
 * `arm()` (re)starts the countdown: `overrideMinutes ?? getMinutes()` minutes
 * to `onTimeout`, with `onWarn` fired 60s before — skipped entirely when the
 * countdown is 90s or shorter (a warning that close to the deadline is noise).
 * `getMinutes` is re-read on every arm so settings changes apply on the next
 * touch/foreground, matching the old hook's behavior.
 */

const WARN_LEAD_MS = 60_000;
const MIN_WARNABLE_MS = 90_000;

export interface IdleTimerOptions {
  getMinutes: () => number;
  onTimeout: () => void;
  onWarn?: () => void;
  /** Forces the timeout regardless of the setting (test sessions pin this to 15). */
  overrideMinutes?: number;
}

export interface IdleTimer {
  arm(): void;
  dispose(): void;
}

export function createIdleTimer(opts: IdleTimerOptions): IdleTimer {
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let warnTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (warnTimer !== null) {
      clearTimeout(warnTimer);
      warnTimer = null;
    }
  }

  return {
    arm(): void {
      clearTimers();
      const mins = opts.overrideMinutes ?? opts.getMinutes();
      if (mins <= 0) return; // disabled
      const ms = mins * 60_000;
      timeoutTimer = setTimeout(() => {
        timeoutTimer = null;
        opts.onTimeout();
      }, ms);
      if (opts.onWarn && ms > MIN_WARNABLE_MS) {
        warnTimer = setTimeout(() => {
          warnTimer = null;
          opts.onWarn!();
        }, ms - WARN_LEAD_MS);
      }
    },
    dispose(): void {
      clearTimers();
    },
  };
}
