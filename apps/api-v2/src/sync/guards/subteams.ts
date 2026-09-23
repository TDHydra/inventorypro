import { resolveTeamAuthority } from '../../lib/teamAuthority';
import type { TableGuard } from '../types';

// subteams (#123): the manage_teams table gate (privileged phase) is not
// enough — a tier-2 crew lead holds manage_teams but may only shape crews of a
// team they actually MANAGE. resolveTeamAuthority (the teams source of truth):
// org authority (tier 3+) OR is_manager of THAT team. The team id comes from
// the payload when present (INSERT/UPDATE) or the existing row (partial
// UPDATE / DELETE keyed on id); a subteam whose team cannot be resolved fails
// closed with permanent wording.
export const subteamsGuard: TableGuard = {
  table: 'subteams',
  async authorizeRow(ctx, entry) {
    let teamId = entry.payload.team_id == null ? null : String(entry.payload.team_id);
    if (teamId == null) {
      try {
        const { rows: stRows } = await ctx.pg.query(
          `SELECT team_id FROM subteams WHERE id = $1`, [entry.payload.id],
        );
        teamId = stRows[0] ? String((stRows[0] as { team_id: string }).team_id) : null;
      } catch { teamId = null; }
    }
    if (teamId == null) {
      return { error: 'Forbidden: subteam team could not be resolved', code: 'VALIDATION' };
    }
    const auth = await resolveTeamAuthority(ctx.pg, ctx.userId, teamId);
    if (!auth.orgAdmin && !auth.managerOnly) {
      ctx.log.warn(
        { userId: ctx.userId, role: ctx.caller.role, teamId, operation: entry.operation },
        'sync push subteams denied (not a manager of this team)',
      );
      return { error: 'Forbidden: you do not manage this team', code: 'FORBIDDEN' };
    }
    return undefined;
  },
};
