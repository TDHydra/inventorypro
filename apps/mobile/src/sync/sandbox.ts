/**
 * Test-session sandbox flag.
 *
 * While active (a `users.is_test` demo account is signed in), the sync engine
 * goes fully dormant: no push (throwaway local edits must never reach the
 * server — which would reject them anyway) and no pull (an incremental pull's
 * INSERT OR REPLACE would clobber the visitor's sandbox edits mid-demo).
 * The local DB is wiped at logout, so nothing here needs to survive.
 *
 * Lives in its own module (not engine.ts) to avoid an auth ↔ engine import
 * cycle: finishLogin sets it, the engine reads it.
 */

let active = false;

export function setSandboxActive(value: boolean): void {
  active = value;
}

export function isSandboxActive(): boolean {
  return active;
}
