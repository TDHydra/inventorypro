import { canActOnTarget, canAssignRole } from '../../lib/permissions';
import { requiresRolesPermForTarget, touchTeamsAndLocationsIfViewPermsChanged } from '../../lib/syncPolicy';
import type { TableGuard } from '../types';

// Target-role guard for users writes: applyWritePolicy gates WHICH columns a
// manage_users-only caller may set, but not WHOSE row. A manage_users holder
// without manage_roles_permissions must not be able to deactivate/expire a
// full_admin/franchise_manager via a crafted outbox entry — REST PATCH
// /users/:id already blocks the equivalent via PRIVILEGED_ROLES. DELETE on
// users is unconditionally forbidden upstream; INSERT is an upsert
// (ON CONFLICT DO UPDATE) so it must be guarded too, not just UPDATE.
export const usersGuard: TableGuard = {
  table: 'users',
  async authorizeRow(ctx, entry) {
    if (entry.operation !== 'UPDATE' && entry.operation !== 'INSERT') return undefined;
    const { userId, caller } = ctx;
    const targetId = entry.payload.id;
    const { rows: targetRows } = await ctx.pg.query(
      `SELECT role, active FROM users WHERE id = $1`,
      [targetId],
    );
    const target = targetRows[0] as { role: string; active: boolean } | undefined;
    if (target) {
      if (requiresRolesPermForTarget(target.role) && !ctx.can('manage_roles_permissions')) {
        ctx.log.warn(
          { userId, role: caller.role, targetId, targetRole: target.role },
          'sync push users update denied (target-role guard)',
        );
        return { error: 'Forbidden: target user has a privileged role; requires roles & permissions', code: 'FORBIDDEN' };
      }
      // Tier guard (security-critical): the caller must be at or above the
      // target's tier to touch their row at all (apex full_admin only touchable
      // by a full_admin). Fails closed on unknown roles.
      if (!canActOnTarget(caller.role, target.role)) {
        ctx.log.warn(
          { userId, role: caller.role, targetId, targetRole: target.role },
          'sync push users write denied (tier guard)',
        );
        return { error: 'Forbidden: target user is at or above your level', code: 'FORBIDDEN' };
      }
      // Assigning/changing the role: the NEW role must also be at or below the
      // caller's tier — no promoting anyone up to (or past) your own level.
      if (entry.payload.role != null && !canAssignRole(caller.role, String(entry.payload.role))) {
        ctx.log.warn(
          { userId, role: caller.role, targetId, newRole: entry.payload.role },
          'sync push users role-assign denied (tier guard)',
        );
        return { error: 'Forbidden: cannot assign a role at or above your level', code: 'FORBIDDEN' };
      }
      // "Deactivating" = explicit active:false OR pushing expires_at into the
      // past (login enforces expires_at, so a past date locks the account out).
      const exp = entry.payload.expires_at;
      const expiredOut = exp != null && !Number.isNaN(Date.parse(String(exp))) && new Date(String(exp)) < new Date();
      const deactivating = entry.payload.active === false || expiredOut;
      if (deactivating && targetId === userId) {
        return { error: 'Forbidden: you cannot deactivate your own account', code: 'FORBIDDEN' };
      }
      if (deactivating && target.active && target.role === 'full_admin') {
        const { rows: activeAdminRows } = await ctx.pg.query(
          `SELECT COUNT(*)::int AS n FROM users WHERE role = 'full_admin' AND active = true`,
          [],
        );
        const activeAdminCount = (activeAdminRows[0] as { n: number }).n;
        if (activeAdminCount <= 1) {
          return { error: 'Forbidden: cannot deactivate the last active full_admin', code: 'FORBIDDEN' };
        }
      }
    } else if (entry.operation === 'INSERT') {
      // No existing row (fresh UUID INSERT): the `if (target)` checks above
      // were all skipped, so the role-assignment tier guard never ran — a
      // manage_users-only caller could otherwise mint an apex full_admin by
      // INSERTing a brand-new users row. Enforce the assign-tier check here.
      if (entry.payload.role != null && !canAssignRole(caller.role, String(entry.payload.role))) {
        ctx.log.warn(
          { userId, role: caller.role, targetId, newRole: entry.payload.role },
          'sync push users insert role-assign denied (tier guard)',
        );
        return { error: 'Forbidden: cannot assign a role at or above your level', code: 'FORBIDDEN' };
      }
    }
    return undefined;
  },
  // #204: see roleSettings guard — same re-pull touch when a users row's
  // permission_overrides changed view_teams/view_locations.
  async afterApply(ctx, entry) {
    if ('permission_overrides' in entry.payload) {
      await touchTeamsAndLocationsIfViewPermsChanged(ctx.pg, entry.payload.permission_overrides);
    }
  },
};
