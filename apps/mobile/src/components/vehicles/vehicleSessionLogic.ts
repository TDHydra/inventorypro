// Pure vehicle-session logic (no react / react-native / DB imports) so the
// invariants run under plain `node --test` — precedent: ui/quantityMath.ts,
// ui/dateFieldLogic.ts. The DB layer (queries/vehicles.ts) and the panel both
// consume these so the close-only payload shape and the who-holds-it decision
// live in exactly one place.

export interface SessionLike {
  id: string;
  user_id: string;
  checked_in_at: string | null; // null = open
}

/**
 * What the panel's primary button should do given the (possibly stale) active
 * session and the current user:
 *  - check_out : no open session
 *  - check_in  : the current user holds the open session
 *  - take_over : someone else holds it (warn via confirmSheet, then close+reopen)
 */
export type CheckoutAction =
  | { kind: 'check_out' }
  | { kind: 'check_in'; sessionId: string }
  | { kind: 'take_over'; sessionId: string; holderId: string };

export function resolveCheckoutAction(
  active: SessionLike | null,
  currentUserId: string | null,
): CheckoutAction {
  if (!active || active.checked_in_at != null) return { kind: 'check_out' };
  if (currentUserId != null && active.user_id === currentUserId) {
    return { kind: 'check_in', sessionId: active.id };
  }
  return { kind: 'take_over', sessionId: active.id, holderId: active.user_id };
}

/**
 * The CLOSE-ONLY update payload. The server's takeover guard requires the
 * pushed row to contain EXACTLY {id, checked_in_at, updated_at} on an open
 * session — any extra key turns it into a regular (denied) cross-user UPDATE.
 * Own-row check-ins use the same shape so there is a single closing payload.
 */
export function buildClosePayload(
  sessionId: string,
  nowIso: string,
): { id: string; checked_in_at: string; updated_at: string } {
  return { id: sessionId, checked_in_at: nowIso, updated_at: nowIso };
}

/** Compact "since" duration for the checkout card: '3m', '2h 15m', '3d 4h'. */
export function formatSince(fromIso: string, nowIso: string): string {
  const ms = Date.parse(nowIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}

/** Display label for a water state ('' for unset). */
export function waterStateLabel(state: string | null | undefined): string {
  if (state === 'full') return 'Full of water';
  if (state === 'empty_clean') return 'Empty + clean tank';
  return '';
}

/** Display label for a service-record target. */
export function serviceTargetLabel(target: string | null | undefined): string {
  if (target === 'truck_mount') return 'Truck mount';
  if (target === 'both') return 'Both';
  return 'Vehicle';
}
