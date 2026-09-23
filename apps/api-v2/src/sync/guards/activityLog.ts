import { activityActionPolicy } from '../../lib/syncPolicy';
import type { TableGuard } from '../types';

// H3: gate privileged/forgeable audit actions BEFORE applyEntry writes them.
// activity_log rows are immutable (Postgres no_update/no_delete RULEs) so a
// forged entry is permanent, and isAllowedActivity only checks the action is
// a known string — not that the caller may perform it. Runs in preAuthorize
// (before the test-account/maintenance gates — old monolith order) so a
// rejection is a permanent conflict, not the generic retryable one
// applyEntry's catch would produce.
export const activityLogGuard: TableGuard = {
  table: 'activity_log',
  async preAuthorize(ctx, entry) {
    if (entry.operation !== 'INSERT') return undefined;
    const ap = activityActionPolicy(String(entry.payload.action ?? ''));
    if (ap.serverOnly) {
      return { error: 'Forbidden: activity_log action is written server-side only', code: 'NOT_ALLOWED' };
    }
    if (ap.requiredPerm && !ctx.can(ap.requiredPerm)) {
      ctx.log.warn(
        { userId: ctx.userId, role: ctx.caller.role, action: entry.payload.action, requiredPerm: ap.requiredPerm },
        'sync push activity_log action denied (authz)',
      );
      return { error: `Forbidden: activity_log action '${entry.payload.action}' requires ${ap.requiredPerm}`, code: 'FORBIDDEN' };
    }
    return undefined;
  },
};
