import { resolveUnitInventoryFacts, foreignTeamUnitBlocked } from '../../lib/teamAuthority';
import type { TableGuard } from '../types';

// #162 team-scoped unit inventory: stock writes (INSERT/UPDATE/ADJUST/DELETE
// on stock_by_location) and equipment-unit moves whose location is a
// Vehicle/Locker owned by a user on a team the caller doesn't share require
// manage_other_team_inventory (tier-4 default). Same-team, ownerless-unit,
// unknown-location and main-location writes pass — only owned units restrict.
// Facts come from the DB (lib/teamAuthority.ts), never the payload; the
// rejection wording matches the mobile permanent-rejection regex
// (/forbidden|cannot|not allowed/i) so a revoked write is dropped, not
// retry-looped. Registered '*' (first in authorizeRow order) but self-selects
// the two tables — matches the old monolith position right after the op-perm
// gate.
export const foreignUnitGuard: TableGuard = {
  table: '*',
  async authorizeRow(ctx, entry) {
    if (ctx.can('manage_other_team_inventory')) return undefined;
    const unitTargets: unknown[] = [];
    let unitCheckFailed = false;
    if (entry.table_name === 'stock_by_location') {
      unitTargets.push(entry.payload.location_id);
    } else if (
      entry.table_name === 'equipment_units'
      && (entry.operation === 'INSERT' || entry.operation === 'UPDATE')
    ) {
      // INTO a unit: the payload's target location.
      if (entry.payload.current_location_id != null) unitTargets.push(entry.payload.current_location_id);
      // OUT OF a unit: a write that touches current_location_id also moves
      // the piece away from wherever the row currently sits. Checked for
      // INSERT too — the generic INSERT is an upsert (ON CONFLICT DO
      // UPDATE), and the hub's move path re-INSERTs the full row.
      if ('current_location_id' in entry.payload) {
        try {
          const { rows: euRows } = await ctx.pg.query(
            `SELECT current_location_id FROM equipment_units WHERE id = $1`,
            [entry.payload.id],
          );
          const oldLoc = (euRows[0] as { current_location_id: string | null } | undefined)?.current_location_id;
          if (oldLoc != null && String(oldLoc) !== String(entry.payload.current_location_id ?? '')) {
            unitTargets.push(oldLoc);
          }
        } catch { unitCheckFailed = true; }
      }
    }
    let unitDenied = false;
    for (const target of unitTargets) {
      if (unitCheckFailed) break;
      try {
        const facts = await resolveUnitInventoryFacts(ctx.pg, target, ctx.userId);
        if (foreignTeamUnitBlocked(facts, false)) { unitDenied = true; break; }
      } catch { unitCheckFailed = true; }
    }
    if (unitCheckFailed) {
      // Lookup failure is transient — surface a NON-permanent conflict so
      // the entry retries instead of being silently dropped.
      return { error: 'team inventory check failed', code: 'CONFLICT' };
    }
    if (unitDenied) {
      ctx.log.warn(
        { userId: ctx.userId, role: ctx.caller.role, table: entry.table_name, operation: entry.operation },
        'sync push denied (foreign-team unit inventory)',
      );
      return { error: 'Forbidden: this unit\'s inventory belongs to another team (requires manage_other_team_inventory)', code: 'FORBIDDEN' };
    }
    return undefined;
  },
};
