// Server-side session death → app-side logout. The API can revoke a session
// out from under the app (refresh token expired after 30 days, admin
// deactivation, a server-side purge) — before this bus, getValidJwt() silently
// kept the dead JWT, background sync 401'd forever, and the UI stayed
// "logged in" with silently-stale data.
//
// Same shape as setWebIdleLogoutHandler (useWebIdleWipe.ts): the app root
// registers a handler once mounted (alert + the SessionContext logout());
// auth/sync internals call noteSessionExpired() when the server DEFINITIVELY
// rejects the session — a 401/403 from /auth/refresh, never a network error or
// 5xx (those are transient; sync already degrades gracefully offline).
//
// Fires at most once per session: push + pull can both hit 401 in the same
// sync cycle, and one alert is plenty. resetSessionExpiredNotice() re-arms on
// the next sign-in (the root layout's user-keyed effect).

let handler: (() => void) | null = null;
let fired = false;

/** Register (or clear, with null) the root-layout logout handler. */
export function setSessionExpiredHandler(fn: (() => void) | null): void {
  handler = fn;
}

/** The session died server-side — run the app logout (once). */
export function noteSessionExpired(): void {
  if (fired) return;
  fired = true;
  handler?.();
}

/** Re-arm after a successful sign-in so the NEXT expiry fires again. */
export function resetSessionExpiredNotice(): void {
  fired = false;
}

/** Test-only: reset module state between node:test cases. */
export function resetSessionExpiredBusForTest(): void {
  handler = null;
  fired = false;
}
