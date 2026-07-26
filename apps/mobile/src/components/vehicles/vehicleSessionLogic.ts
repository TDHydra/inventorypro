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

/** Display label for the water tank ('' for unset/unknown — legacy values never reach labels). */
export function waterTankLabel(tank: string | null | undefined): string {
  if (tank === 'full') return 'Water: full';
  if (tank === 'empty') return 'Water: empty';
  return '';
}

/** Display label for the waste tank ('' for unset/unknown). */
export function wasteTankLabel(tank: string | null | undefined): string {
  if (tank === 'clean') return 'Waste: clean';
  if (tank === 'dirty') return 'Waste: dirty';
  return '';
}

/** Display label for a service-record target. */
export function serviceTargetLabel(target: string | null | undefined): string {
  if (target === 'truck_mount') return 'Truck mount';
  if (target === 'both') return 'Both';
  return 'Vehicle';
}

// ── #141: takeover attribution + history panel helpers ──────────────────────

/**
 * Takeover audit note: names the prior driver and when they checked out, so the
 * closed session's context survives in the activity log even after the row
 * itself is superseded. ISO timestamp on purpose — the log is machine-read too.
 */
export function buildTakeoverNote(
  holderName: string | null,
  checkedOutAtIso: string,
  nowIso: string,
): string {
  const dur = formatSince(checkedOutAtIso, nowIso) || '0m';
  return `took over from ${holderName ?? 'unknown driver'} (out since ${checkedOutAtIso}, ${dur})`;
}

/**
 * Fuel-up service-record type. vehicle_service_records.type is free TEXT (no
 * taxonomy, never a PG enum) and the table has NO metadata column, so gallons
 * ride in the notes text via the build/parse pair below.
 */
export const FUEL_UP_TYPE = 'fuel_up';

/** Compose fuel-up notes: "<gallons> gal — <free text>" (either part optional). */
export function buildFuelUpNotes(gallons: number | null, notes: string): string | null {
  const parts: string[] = [];
  if (gallons != null) parts.push(`${gallons} gal`);
  if (notes.trim()) parts.push(notes.trim());
  return parts.length ? parts.join(' — ') : null;
}

/** Read the gallons prefix back out of fuel-up notes (null when absent). */
export function parseFuelUpGallons(notes: string | null): number | null {
  const m = notes?.match(/^(\d+(?:\.\d+)?) gal(?:\b|$)/);
  return m ? parseFloat(m[1]) : null;
}

/** Display label for a service-record type ('fuel_up' is the only coded value). */
export function serviceTypeLabel(type: string): string {
  return type === FUEL_UP_TYPE ? 'Fuel-up' : type;
}

/**
 * Miles driven between consecutive odometer readings. Input is newest-first
 * (as the timeline query returns); the oldest row has nothing to diff against.
 */
export function odometerDeltas<T extends { odometer: number }>(rowsDesc: readonly T[]): (number | null)[] {
  return rowsDesc.map((r, i) => {
    const older = rowsDesc[i + 1];
    return older ? r.odometer - older.odometer : null;
  });
}

/**
 * #167 phase 0: who holds the lock after applying `patch`.
 * 0→1 stamps the acting user; 1→1 keeps the original locker (a legacy NULL
 * locker adopts the actor); →0 clears; a patch not touching checkout_locked
 * carries the existing stamp. The unlock RULE (tier comparison) is the #167
 * UI phase — this is write plumbing only.
 */
export function resolveLockStamp(
  patch: { checkout_locked?: number },
  existing: { checkout_locked: number; locked_by: string | null } | null,
  userId: string | null,
): string | null {
  if (patch.checkout_locked === undefined) return existing?.locked_by ?? null;
  if (!patch.checkout_locked) return null;
  if (existing?.checkout_locked) return existing.locked_by ?? userId;
  return userId;
}

// ── #155: checkout availability (role-free, owner-aware) ───────────────────

export type AvailabilityReason = 'checked_out' | 'owned_closed';
export interface VehicleAvailability { available: boolean; reason: AvailabilityReason | null; }

/**
 * #155: available ⇔ no open session AND (unowned OR opted in OR caller owns it).
 * Role NEVER gates vehicle checkout. Locking (#167) composes on top via
 * isCheckoutLockedFor — it is deliberately not this function's concern.
 */
export function resolveVehicleAvailability(input: {
  ownerUserId: string | null;
  openCheckout: number; // vehicles.open_checkout 0/1
  hasOpenSession: boolean;
  userId: string | null;
}): VehicleAvailability {
  if (input.hasOpenSession) return { available: false, reason: 'checked_out' };
  if (input.ownerUserId == null) return { available: true, reason: null };
  if (input.userId != null && input.userId === input.ownerUserId) return { available: true, reason: null };
  if (input.openCheckout) return { available: true, reason: null };
  return { available: false, reason: 'owned_closed' };
}

/**
 * #167 lock hierarchy: may the caller LIFT (and therefore bypass) the current
 * lock? canManage is the caller's canManageVehicle result; tiers are ROLE_TIER
 * values resolved by the caller (this module stays DB-free). Legacy NULL locker
 * and self-locks are always liftable by a manager; otherwise tier must be >=
 * the locker's CURRENT tier (deleted locker → pass 0).
 */
export function canLiftVehicleLock(input: {
  canManage: boolean;
  lockedBy: string | null;
  lockerTier: number;
  userId: string | null;
  userTier: number;
}): boolean {
  if (!input.canManage) return false;
  if (input.lockedBy == null) return true;
  if (input.userId != null && input.lockedBy === input.userId) return true;
  return input.userTier >= input.lockerTier;
}

/** #152: committed debris values snap to 10s and clamp to 0–100 (drag is continuous, commit is coarse). */
export function snapDebrisLevel(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, Math.round(raw / 10) * 10));
}

/** #174: committed fuel values snap to 10s and clamp to 0–100 — same idiom as snapDebrisLevel. */
export function snapFuelLevel(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, Math.round(raw / 10) * 10));
}

/**
 * #168: the user has a vehicle checked out but filed the gas receipt against a
 * different one — allowed, but the mismatch is recorded in the activity log.
 */
export function buildReceiptVehicleMismatchNote(checkedOutName: string, chosenName: string): string {
  return `fuel_up receipt: user checked out ${checkedOutName} but logged against ${chosenName}`;
}
