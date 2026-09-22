// src/hooks/useWebIdleWipe.ts
//
// Web-only idle auto-wipe. The native app has `useIdleLogout` (driven by RN
// AppState + a touch responder); the browser has no equivalent, so this installs
// document-level activity listeners and, after ~15 minutes of no interaction,
// runs the supplied wipe callback (drop session token + encrypted DB key) to
// force re-auth. Everything guards on browser globals so importing this from a
// `.web.ts` twin can never affect a native bundle.

import { createIdleTimer } from './idleTimerCore';

const DEFAULT_IDLE_MINUTES = 15;

// Passive, capture-phase listeners so we observe activity without interfering
// with React's own handlers.
const ACTIVITY_EVENTS: Array<keyof DocumentEventMap> = [
  'mousedown',
  'keydown',
  'touchstart',
  'pointerdown',
  'scroll',
  'visibilitychange',
];

let installed = false;

// Optional handler that flips the in-memory React SessionContext to logged-out
// (i.e. the provider's own `logout()` = clearSession + setUser(null)). It lives
// in the app root (app/_layout.tsx), outside this module, so the root registers
// it once mounted and the idle wipe invokes it to drive an immediate redirect to
// login instead of waiting for the next route guard. Registering `null` clears
// it. Kept here (a browser-guarded, native-safe module) so the root can import
// the setter without pulling web-only session internals into the native bundle.
let logoutHandler: (() => void | Promise<void>) | null = null;

/** Register (or clear, with null) the React logout handler used by the idle wipe. */
export function setWebIdleLogoutHandler(fn: (() => void | Promise<void>) | null): void {
  logoutHandler = fn;
}

/** The currently-registered React logout handler, or null. */
export function getWebIdleLogoutHandler(): (() => void | Promise<void>) | null {
  return logoutHandler;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Install a single global idle-wipe listener set. Idempotent — calling it more
 * than once is a no-op. Safe to call at module load on web; a no-op elsewhere.
 * Timer semantics (including the 60s-before warning) come from
 * `idleTimerCore.ts`, shared with the native `useIdleLogout`.
 *
 * @param onIdle        Called once when the idle threshold is reached.
 * @param minutes       Idle threshold; defaults to ~15 min. <=0 disables.
 * @param opts.onWarn      Fired 60s before the wipe (skipped for thresholds ≤90s).
 * @param opts.onActivity  Fired on every re-arming user interaction (e.g. to
 *                         dismiss a visible "still there?" nudge).
 */
export function installWebIdleWipe(
  onIdle: () => void,
  minutes: number = DEFAULT_IDLE_MINUTES,
  opts?: { onWarn?: () => void; onActivity?: () => void },
): void {
  if (installed || !isBrowser()) return;
  installed = true;

  const timer = createIdleTimer({
    getMinutes: () => minutes,
    onTimeout: () => {
      try {
        onIdle();
      } catch {
        /* wipe is best-effort */
      }
    },
    onWarn: opts?.onWarn,
  });

  const onActivity = (e: Event) => {
    // A tab returning to the foreground counts as activity; a tab being hidden
    // does not re-arm (the timer keeps counting so a walked-away session wipes).
    if (e.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
    timer.arm();
    opts?.onActivity?.();
  };

  for (const evt of ACTIVITY_EVENTS) {
    document.addEventListener(evt, onActivity, { capture: true, passive: true });
  }
  timer.arm();
}
