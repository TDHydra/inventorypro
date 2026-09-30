import type { SqlDb } from '../types';

// Migration 057: link repair_parts to the troubleshooting step it was
// consumed under (#178 Part 4). Mirrors API 072. Nullable, no FK (repair_parts
// itself carries no FKs — sync-order safety).
export const migration = {
  version: 57,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE repair_parts ADD COLUMN step_id TEXT`);
  },
};
