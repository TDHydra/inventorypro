import { canManageUnitAccess } from '../../lib/unitAccessPolicy';
import type { TableGuard } from '../types';

// unit_access (#122 Phase B): per-action grants gate vehicle/locker stock
// access, so writes are owner ∪ manager-of-owner's-team ∪ production manager
// ∪ tier-3+ — and every non-owner editor must out-tier the GRANTEE
// (canManageUnitAccess, lib/unitAccessPolicy.ts). All facts come from the DB,
// never the payload; a missing location fails closed with permanent wording
// (matches the mobile engine's drop regex).
export const unitAccessGuard: TableGuard = {
  table: 'unit_access',
  async authorizeRow(ctx, entry) {
    let uaFacts:
      | { owner_user_id: string | null; grantee_role: string | null; manages_owner_team: boolean }
      | undefined;
    try {
      const { rows: uaRows } = await ctx.pg.query(
        `SELECT l.owner_user_id,
                (SELECT role FROM users WHERE id = $2) AS grantee_role,
                EXISTS (SELECT 1 FROM team_members om
                          JOIN team_members cm ON cm.team_id = om.team_id AND cm.is_manager = TRUE
                         WHERE om.user_id = l.owner_user_id AND cm.user_id = $3) AS manages_owner_team
           FROM locations l WHERE l.id = $1`,
        [entry.payload.location_id, entry.payload.user_id, ctx.userId],
      );
      uaFacts = uaRows[0] as typeof uaFacts;
    } catch { uaFacts = undefined; }
    if (!uaFacts) {
      return { error: 'Forbidden: unit location does not exist', code: 'VALIDATION' };
    }
    const allowed = canManageUnitAccess({
      callerId: ctx.userId,
      callerRole: ctx.caller.role,
      ownerUserId: uaFacts.owner_user_id == null ? null : String(uaFacts.owner_user_id),
      callerManagesOwnersTeam: uaFacts.manages_owner_team === true,
      granteeRole: uaFacts.grantee_role == null ? null : String(uaFacts.grantee_role),
    });
    if (!allowed) {
      ctx.log.warn(
        { userId: ctx.userId, role: ctx.caller.role, locationId: entry.payload.location_id, operation: entry.operation },
        'sync push unit_access denied (not owner/team-manager/PM)',
      );
      return { error: 'Forbidden: you cannot manage access to this unit', code: 'FORBIDDEN' };
    }
    return undefined;
  },
};
