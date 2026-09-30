import { getAppSetting, setAppSetting } from '../db/appSettings';
import { isReauthDue } from './reauthCore';
import { requireReauth, clearReauthRequired } from './reauthGate';

/**
 * Device-local, UNSYNCED app_settings key — deliberately never mirrored to
 * the sync outbox (this is a per-DEVICE activity stamp, not per-user data;
 * syncing it would let one device's activity satisfy another device's gate).
 */
const LAST_ACTIVE_KEY = 'idle_reauth_last_active_at';

/** Stamp "the user did something" — called on every touch (the same
 * interceptor that resets the org-wide idle-logout timer) plus login/unlock. */
export function touchReauthActivity(): void {
  try {
    setAppSetting(LAST_ACTIVE_KEY, new Date().toISOString());
  } catch {
    /* best-effort — a missed stamp just means the next check re-evaluates
       against a stale one, which only makes the gate MORE likely to fire,
       never less (fail-safe direction for a security gate). */
  }
}

/** Called after a successful PIN re-entry (or login/unlock) — stamps activity
 * AND lowers the gate. Login/unlock also stamp fresh activity so a brand-new
 * session never immediately re-triggers the check it just satisfied. */
export function markReauthed(): void {
  touchReauthActivity();
  clearReauthRequired();
}

/**
 * Called on AppState→active. Catches the "backgrounded in a pocket/drawer"
 * case that the foreground-only idle timer instance can't see (its setTimeout
 * doesn't run while suspended) — see reauthCore.ts's header comment. Never
 * lowers an already-raised gate; only `markReauthed()` (a successful PIN
 * entry) does that.
 */
export function checkReauthDue(idleReauthMinutes: number): void {
  if (idleReauthMinutes <= 0) return;
  let lastActive: string | null = null;
  try {
    lastActive = getAppSetting(LAST_ACTIVE_KEY);
  } catch {
    return; // can't read — don't false-positive lock on a transient DB error
  }
  if (isReauthDue(lastActive, idleReauthMinutes, new Date().toISOString())) {
    requireReauth();
  }
}
