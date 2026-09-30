import type { SqlDb } from '../types';

// Migration 023: repair SLA fields (assignee, cost, due date) + repair_parts
// (inventory consumed by a repair). Mirrors API migration 028. No FK on
// repair_id/item_id — matches repairs' sync-order-safe design.
export const migration = {
  version: 23,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE repairs ADD COLUMN assignee_id TEXT`);
    db.executeSync(`ALTER TABLE repairs ADD COLUMN cost REAL`);
    db.executeSync(`ALTER TABLE repairs ADD COLUMN due_at TEXT`);
    db.executeSync(`CREATE TABLE IF NOT EXISTS repair_parts (
      id TEXT PRIMARY KEY,
      repair_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      qty REAL NOT NULL,
      unit TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
  },
};
