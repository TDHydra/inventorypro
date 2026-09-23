import type { TableGuard } from '../types';

// vehicle_checkouts UPDATE (#125/#127): own row, OR manage_teams, OR the
// close-only takeover — the payload sets ONLY checked_in_at on an OPEN
// session (warn-and-take-over: any checkout_inventory holder may CLOSE a
// stale session to take the vehicle, but may not edit its job/vehicle or
// reopen it; user_id itself is attribution-protected, so the closed row
// keeps its original holder). Row facts come from the DB, never the
// payload; a missing row fails closed with permanent wording.
export const vehicleCheckoutsGuard: TableGuard = {
  table: 'vehicle_checkouts',
  async authorizeRow(ctx, entry) {
    if (entry.operation !== 'UPDATE') return undefined;
    let vcRow: { user_id: string | null; checked_in_at: string | null } | undefined;
    try {
      const { rows: vcRows } = await ctx.pg.query(
        `SELECT user_id, checked_in_at FROM vehicle_checkouts WHERE id = $1`, [entry.payload.id],
      );
      vcRow = vcRows[0] as { user_id: string | null; checked_in_at: string | null } | undefined;
    } catch { vcRow = undefined; }
    if (!vcRow) {
      return { error: 'Forbidden: vehicle checkout session does not exist', code: 'VALIDATION' };
    }
    const ownRow = vcRow.user_id != null && String(vcRow.user_id) === ctx.userId;
    if (!ownRow && !ctx.can('manage_teams')) {
      const touched = Object.keys(entry.payload)
        .filter(k => !['id', 'user_id', 'updated_at', 'synced_at', '__version'].includes(k));
      const closeOnly = vcRow.checked_in_at == null
        && entry.payload.checked_in_at != null
        && touched.length > 0
        && touched.every(k => k === 'checked_in_at');
      if (!closeOnly) {
        ctx.log.warn(
          { userId: ctx.userId, role: ctx.caller.role, checkoutId: entry.payload.id },
          'sync push vehicle_checkouts update denied (not the holder)',
        );
        return { error: 'Forbidden: cannot modify another user\'s vehicle checkout', code: 'FORBIDDEN' };
      }
    }
    return undefined;
  },
};
