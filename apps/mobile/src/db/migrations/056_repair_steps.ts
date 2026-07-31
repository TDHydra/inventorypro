import type { SqlDb } from '../types';

// Migration 056: repair troubleshooting steps log (#178 v1). Mirrors API 071.
// SYNCED table (docs/SYNC-MIGRATION-CHECKLIST.md — pull.ts TABLE_UPSERT_SQL/
// rowToValues AND sync/fullDownload.ts's SYNC_TABLES are extended in the same
// change). No FK on repair_id — matches repair_parts' (023) sync-order-safe
// design, so a step can pull/push before or after its parent repair row.
export const migration = {
  version: 56,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS repair_steps (
      id TEXT PRIMARY KEY,
      repair_id TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS repair_steps_repair_id_idx ON repair_steps (repair_id)`);
  },
};
