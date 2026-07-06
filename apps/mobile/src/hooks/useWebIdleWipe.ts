// src/hooks/useWebIdleWipe.ts
//
// Web-only idle auto-wipe. The native app has `useIdleLogout` (driven by RN
// AppState + a touch responder); the browser has no equivalent, so this installs
// document-level activity listeners and, after ~15 minutes of no interaction,
// runs the supplied wipe callback (drop session token + encrypted DB key) to
// force re-auth. Everything guards on browser globals so importing this from a
// `.web.ts` twin can never affect a native bundle.

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
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Install a single global idle-wipe listener set. Idempotent — calling it more
 * than once is a no-op. Safe to call at module load on web; a no-op elsewhere.
 *
 * @param onIdle   Called once when the idle threshold is reached.
 * @param minutes  Idle threshold; defaults to ~15 min. <=0 disables.
 */
export function installWebIdleWipe(onIdle: () => void, minutes: number = DEFAULT_IDLE_MINUTES): void {
  if (installed || !isBrowser()) return;
  installed = true;

  const ms = minutes * 60_000;

  const arm = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (minutes <= 0) return; // disabled
    idleTimer = setTimeout(() => {
      idleTimer = null;
      try {
        onIdle();
      } catch {
        /* wipe is best-effort */
      }
    }, ms);
  };

  const onActivity = (e: Event) => {
    // A tab returning to the foreground counts as activity; a tab being hidden
    // does not re-arm (the timer keeps counting so a walked-away session wipes).
    if (e.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
    arm();
  };

  for (const evt of ACTIVITY_EVENTS) {
    document.addEventListener(evt, onActivity, { capture: true, passive: true });
  }
  arm();
}
