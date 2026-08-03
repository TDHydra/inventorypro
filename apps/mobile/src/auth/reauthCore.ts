/**
 * Pure calculation behind the per-role idle re-auth gate (#244 / idea 31).
 *
 * IMPORTANT correction this feature is built around: the app's existing
 * `useIdleLogout`/`idleTimerCore` fully re-arms on every AppState→active
 * transition, so time the app spent BACKGROUNDED never counts toward that
 * timer — a phone that sat in a pocket for hours resets the clock the instant
 * it's woken. That's the right primitive for "auto-logout after foreground
 * inactivity", but the wrong one for a security re-auth gate, which must
 * count WALL-CLOCK elapsed time since the user was last active, foreground or
 * not. `isReauthDue` is deliberately independent of any timer: it compares two
 * ISO timestamps, so it works identically whether the gap was spent idle on
 * screen or fully backgrounded.
 *
 * Deliberately independent from — and never cross-validated against — the
 * org-wide `idle_timeout_minutes` (app_settings) auto-logout: that setting
 * ends the session outright; this one only re-prompts for the PIN while the
 * session stays intact. A role can have both, either, or neither enabled with
 * no interaction between them.
 */

/**
 * @param lastActiveIso ISO timestamp of the last touch/login/unlock/reauth on
 *   this device, or `null` if never stamped (fresh install / feature just
 *   turned on for this role). `null` fails OPEN (not due) — a missing stamp
 *   must never lock a user out forever, mirroring the NULL/NULL "disabled"
 *   convention quiet hours already established for a missing pref.
 * @param idleReauthMinutes role_settings.idle_reauth_minutes; `<= 0` disables
 *   the gate entirely (the DEFAULT for every role until an admin opts in).
 * @param nowIso ISO timestamp of "now" (injected, not `Date.now()`, so this
 *   stays pure and table-testable).
 */
export function isReauthDue(
  lastActiveIso: string | null,
  idleReauthMinutes: number,
  nowIso: string,
): boolean {
  if (idleReauthMinutes <= 0) return false;
  if (!lastActiveIso) return false;

  const lastActiveMs = new Date(lastActiveIso).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (isNaN(lastActiveMs) || isNaN(nowMs)) return false;

  const elapsedMs = nowMs - lastActiveMs;
  // A negative gap means the stamp is somehow in the future (clock change/skew)
  // — fail open rather than instantly locking the user out.
  if (elapsedMs < 0) return false;

  return elapsedMs >= idleReauthMinutes * 60_000;
}
