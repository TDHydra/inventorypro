import { ROLE_TIER } from '../../lib/permissions';
import { canChangeVehicleLock } from '../../lib/vehicleLockPolicy';
import type { TableGuard } from '../types';

// vehicles lock/share guard (#176): checkout_locked / open_checkout / locked_by
// are protected columns, but mobile's upsertVehicleState (queries/vehicles.ts)
// always pushes the FULL merged row as an INSERT (the generic INSERT is an
// upsert — ON CONFLICT DO UPDATE), so every crew tank/fuel write carries these
// columns UNCHANGED. Guarding on "payload contains the column" would therefore
// block every crew write — the guard fires ONLY when a protected column's
// VALUE actually differs from the DB's. All facts come from the DB, never the
// payload; a missing vehicle LOCATION fails closed with permanent wording. A
// missing `vehicles` extension row (a Vehicle location that predates this
// table, or the first-ever write) defaults to unlocked/opted-out/unclaimed,
// same as the mobile reader.
export const vehiclesGuard: TableGuard = {
  table: 'vehicles',
  async authorizeRow(ctx, entry) {
    if (entry.operation !== 'INSERT' && entry.operation !== 'UPDATE') return undefined;
    let vFacts:
      | { checkoutLocked: boolean; openCheckout: boolean; lockedBy: string | null;
          ownerUserId: string | null; sharesTeam: boolean; lockedByTier: number }
      | undefined;
    try {
      const { rows: vRows } = await ctx.pg.query(
        `SELECT l.owner_user_id,
                COALESCE(v.checkout_locked, false) AS checkout_locked,
                COALESCE(v.open_checkout, false) AS open_checkout,
                v.locked_by,
                EXISTS (SELECT 1 FROM team_members a JOIN team_members b ON b.team_id = a.team_id
                         WHERE a.user_id = $2 AND b.user_id = l.owner_user_id) AS shares_owner_team,
                (SELECT role FROM users WHERE id = v.locked_by) AS locked_by_role
           FROM locations l LEFT JOIN vehicles v ON v.location_id = l.id
          WHERE l.id = $1`,
        [entry.payload.location_id, ctx.userId],
      );
      const vRow = vRows[0] as {
        owner_user_id: string | null; checkout_locked: boolean; open_checkout: boolean;
        locked_by: string | null; shares_owner_team: boolean; locked_by_role: string | null;
      } | undefined;
      vFacts = vRow && {
        checkoutLocked: vRow.checkout_locked === true,
        openCheckout: vRow.open_checkout === true,
        lockedBy: vRow.locked_by,
        ownerUserId: vRow.owner_user_id,
        sharesTeam: vRow.shares_owner_team === true,
        lockedByTier: ROLE_TIER[vRow.locked_by_role ?? ''] ?? 0,
      };
    } catch { vFacts = undefined; }
    if (!vFacts) {
      return { error: 'Forbidden: vehicle location does not exist', code: 'VALIDATION' };
    }
    const asBool = (v: unknown) => v === true || v === 1;
    const nextLocked = 'checkout_locked' in entry.payload ? asBool(entry.payload.checkout_locked) : vFacts.checkoutLocked;
    const nextOpen = 'open_checkout' in entry.payload ? asBool(entry.payload.open_checkout) : vFacts.openCheckout;
    const nextLockedBy = 'locked_by' in entry.payload
      ? (entry.payload.locked_by == null ? null : String(entry.payload.locked_by))
      : vFacts.lockedBy;
    const lockChanged = nextLocked !== vFacts.checkoutLocked;
    const openChanged = nextOpen !== vFacts.openCheckout;
    const lockedByChanged = nextLockedBy !== vFacts.lockedBy;
    if (lockChanged || openChanged) {
      const allowed = canChangeVehicleLock({
        callerId: ctx.userId,
        callerTier: ROLE_TIER[ctx.caller.role] ?? 0,
        ownerUserId: vFacts.ownerUserId,
        sharesTeamWithOwner: vFacts.sharesTeam,
        currentLockedBy: vFacts.lockedBy,
        lockedByTier: vFacts.lockedByTier,
      });
      if (!allowed) {
        ctx.log.warn(
          { userId: ctx.userId, role: ctx.caller.role, locationId: entry.payload.location_id, operation: entry.operation },
          'sync push vehicles lock/share denied',
        );
        return { error: 'Forbidden: you cannot change this vehicle\'s lock/share settings', code: 'FORBIDDEN' };
      }
    }
    // locked_by is server-stamped, never trusted from the payload: a fresh
    // 0→1 lock takes the CALLER's id (it is not in ATTRIBUTION_COLUMNS and is
    // otherwise forgeable); a 1→0 unlock already passed the lift check above,
    // so its payload value is left alone; any locked_by drift WITHOUT a lock
    // transition (crew tank/fuel write, or a crafted payload) is stripped back
    // to the DB's current value.
    if (lockChanged && nextLocked) {
      entry.payload.locked_by = ctx.userId;
    } else if (!lockChanged && lockedByChanged) {
      entry.payload.locked_by = vFacts.lockedBy;
    }
    return undefined;
  },
};
