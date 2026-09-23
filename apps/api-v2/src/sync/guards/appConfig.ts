import type { TableGuard } from '../types';

// demo_mode (#32 S3) is the apex-only demo-account kill switch — it is
// toggled only through its dedicated guarded path (routes/audit.ts), never via
// generic app_config sync (system_settings alone must not flip it). "Forbidden"
// wording marks the rejection permanent to the mobile sync engine.
export const appConfigGuard: TableGuard = {
  table: 'app_config',
  async privileged(ctx, entry) {
    if (entry.payload.key !== 'demo_mode') return undefined;
    ctx.log.warn(
      { userId: ctx.userId, role: ctx.caller.role, operation: entry.operation },
      'sync push app_config demo_mode denied',
    );
    return { error: 'Forbidden: demo_mode cannot be changed via sync', code: 'NOT_ALLOWED' };
  },
};
