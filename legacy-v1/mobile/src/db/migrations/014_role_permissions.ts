import type { SqlDb } from '../types';

// Migration 014: P5 5a — dynamic role→permission assignment.
// permission_overrides holds only deviations from ROLE_DEFAULTS ({perm: bool}) as JSON text;
// empty = pure default. role_settings is already synced (conflict `role`).
export const migration = {
  version: 14,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE role_settings ADD COLUMN permission_overrides TEXT NOT NULL DEFAULT '{}'`);
  },
};
