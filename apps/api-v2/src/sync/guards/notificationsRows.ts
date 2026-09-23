import type { TableGuard } from '../types';

// notifications are per-user inbox rows: clients may only UPDATE (mark read),
// never INSERT/DELETE (op-perm already denies those), and only their OWN row.
// A crafted entry claiming another user's row (payload.user_id != caller) is
// rejected here; the only client-writable column is read_at (SENSITIVE_DENY).
// Row ownership is ALSO enforced in SQL by applyEntry's UPDATE (AND user_id =
// caller) — this guard is the fast, well-worded rejection.
export const notificationsGuard: TableGuard = {
  table: 'notifications',
  async authorizeRow(ctx, entry) {
    if (entry.operation !== 'UPDATE') {
      return { error: 'Forbidden: notifications are read-only except marking read', code: 'NOT_ALLOWED' };
    }
    const targetUser = entry.payload.user_id;
    if (targetUser != null && String(targetUser) !== ctx.userId) {
      return { error: 'Forbidden: cannot modify another user\'s notification', code: 'FORBIDDEN' };
    }
    return undefined;
  },
};
