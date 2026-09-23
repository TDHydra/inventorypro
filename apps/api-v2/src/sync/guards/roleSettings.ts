import { canActOnTarget } from '../../lib/permissions';
import { touchTeamsAndLocationsIfViewPermsChanged } from '../../lib/syncPolicy';
import type { TableGuard } from '../types';

// Tier guard for role_settings (security-critical): editing a role's
// permission matrix is "acting on" that role. The edited role is the row's
// conflict key (payload.role). A caller may only edit permissions for a role
// at or below their own tier (apex full_admin's row only editable by a
// full_admin). Fails closed on unknown roles.
export const roleSettingsGuard: TableGuard = {
  table: 'role_settings',
  async privileged(ctx, entry) {
    const editedRole = entry.payload.role;
    if (!canActOnTarget(ctx.caller.role, editedRole == null ? null : String(editedRole))) {
      ctx.log.warn(
        { userId: ctx.userId, role: ctx.caller.role, editedRole },
        'sync push role_settings denied (tier guard)',
      );
      return { error: 'Forbidden: cannot edit permissions for a role at or above your level', code: 'FORBIDDEN' };
    }

    // Only a full_admin may grant/revoke the destructive delete permissions
    // (mirrors the client lock in roles.tsx). Compare each guarded bit in the
    // incoming overrides against the stored row; deny a CHANGE by a non-apex
    // caller. Other permission edits on the role are unaffected.
    if (ctx.caller.role !== 'full_admin') {
      const parseOv = (v: unknown): Record<string, unknown> => {
        if (v == null) return {};
        if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; } }
        return typeof v === 'object' ? (v as Record<string, unknown>) : {};
      };
      const incoming = parseOv(entry.payload.permission_overrides);
      const { rows: curRows } = await ctx.pg.query(
        `SELECT permission_overrides FROM role_settings WHERE role = $1`,
        [String(editedRole)],
      );
      const current = parseOv((curRows[0] as { permission_overrides: unknown } | undefined)?.permission_overrides);
      const guarded = ['delete_inventory', 'delete_media'].find(perm => {
        const incHas = perm in incoming;
        const curHas = perm in current;
        return incHas !== curHas || (incHas && incoming[perm] !== current[perm]);
      });
      if (guarded) {
        ctx.log.warn(
          { userId: ctx.userId, role: ctx.caller.role, editedRole, perm: guarded },
          'sync push role_settings destructive-grant denied (not full_admin)',
        );
        return { error: `Forbidden: only a full admin can grant or revoke the ${guarded} permission`, code: 'FORBIDDEN' };
      }
    }
    return undefined;
  },
  // #204: this write just changed role_settings.permission_overrides. If the
  // new overrides mention view_teams/view_locations, bump updated_at on
  // teams/team_members/locations so every device's next incremental pull
  // re-fetches them under the now-different projection/row-filter.
  async afterApply(ctx, entry) {
    if ('permission_overrides' in entry.payload) {
      await touchTeamsAndLocationsIfViewPermsChanged(ctx.pg, entry.payload.permission_overrides);
    }
  },
};
