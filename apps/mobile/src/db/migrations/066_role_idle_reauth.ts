import type { SqlDb } from '../types';

// Migration 066: per-role idle re-auth (#244 / idea 31). Mirrors API
// migration 080. `idle_reauth_minutes` gates a NEW mechanism, entirely
// separate from the existing org-wide `idle_timeout_minutes` (app_settings)
// auto-LOGOUT: this one only re-prompts for the PIN while the session stays
// intact (see src/auth/reauthCore.ts's header comment for why a new
// wall-clock-based mechanism was needed instead of reusing idleTimerCore's
// foreground-only countdown). 0 = disabled (DEFAULT for every existing +
// new role — opt-in via the Roles editor, no surprise behavior change on
// ship).
//
// SYNCED column (docs/SYNC-MIGRATION-CHECKLIST.md): pull.ts's
// TABLE_UPSERT_SQL['role_settings'] + rowToValues's role_settings case, plus
// syncPolicy's ROLE_SETTINGS_COLS, all extended in the same change.
export const migration = {
  version: 66,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE role_settings ADD COLUMN idle_reauth_minutes INTEGER NOT NULL DEFAULT 0`);
  },
};
