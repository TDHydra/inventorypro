import { DB } from '@op-engineering/op-sqlite';

// Migration 019: repair tickets. Attach to an equipment unit / item / vehicle
// (location). entity_id has no FK. completed_at set at a terminal status.
export const migration = {
  version: 19,
  up: (db: DB): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS repairs (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_label TEXT,
      notes TEXT,
      parts_needed TEXT,
      status TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      synced_at TEXT
    )`);
  },
};
