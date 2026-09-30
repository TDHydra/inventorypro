// #176: server-side guard for vehicles.checkout_locked / open_checkout / locked_by —
// the single policy the /sync/push per-row guard (routes/sync.ts) enforces. This
// mirrors TWO mobile pure functions combined into one gate:
//   - canManageVehicle (apps/mobile/src/db/queries/access.ts:342-351): owner OR
//     tier>=3 OR (tier>=2 AND shares a team with the owner).
//   - canLiftVehicleLock (apps/mobile/src/components/vehicles/vehicleSessionLogic.ts:
//     187-198): manage authority AND (no current locker OR self OR caller's tier
//     >= the current locker's tier).
// KEEP IN SYNC with both mobile functions.
//
// Composing them into one gate is deliberate: when the vehicle is not currently
// locked (currentLockedBy is null — the DB's pre-write value, never the payload's),
// the lift-stage collapses to true, so the result is exactly canManageVehicle alone
// — matching "locking ON is gated by canManageVehicle alone" (access.ts:355-356).
// When it IS locked, the lift-stage additionally requires the tier/self check —
// exactly canLiftVehicleLock's rule, evaluated against the CALLER (the only
// meaningful "who wants to change this" for both the 1→0 unlock case and any other
// protected-column change made while a lock is held).
export interface VehicleLockChangeFacts {
  callerId: string;
  /** ROLE_TIER[caller's role] ?? 0 — resolved by the caller (permissions.ts). */
  callerTier: number;
  /** locations.owner_user_id — DB truth, never the payload's. */
  ownerUserId: string | null;
  /** caller shares a team with the owner (or is the owner). */
  sharesTeamWithOwner: boolean;
  /** vehicles.locked_by as it CURRENTLY stands in the DB (before this write). */
  currentLockedBy: string | null;
  /** ROLE_TIER of currentLockedBy's CURRENT role; deleted/unknown locker → 0. */
  lockedByTier: number;
}

export function canChangeVehicleLock(f: VehicleLockChangeFacts): boolean {
  const canManage =
    (f.ownerUserId != null && f.ownerUserId === f.callerId)
    || f.callerTier >= 3
    || (f.callerTier >= 2 && f.sharesTeamWithOwner);
  if (!canManage) return false;
  if (f.currentLockedBy == null) return true;
  if (f.currentLockedBy === f.callerId) return true;
  return f.callerTier >= f.lockedByTier;
}
