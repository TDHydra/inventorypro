import type { SqlDb } from '../types';

export const migration = {
  version: 22,
  up: (db: SqlDb): void => {
    // Per-role name color. Nullable: NULL = use the code default (ROLE_COLORS).
    db.executeSync(`ALTER TABLE role_settings ADD COLUMN color TEXT`);
  },
};
