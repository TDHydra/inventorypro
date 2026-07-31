import type { SqlDb } from '../types';

// Migration 058: rooms catalog (#173 job media capture flow). Mirrors API 073.
// SYNCED table (docs/SYNC-MIGRATION-CHECKLIST.md — pull.ts TABLE_UPSERT_SQL/
// rowToValues AND sync/fullDownload.ts's SYNC_TABLES are extended in the same
// change), same as media.room_id below. No FK on media.room_id (matches the
// repair_parts/step_id, repair_steps/repair_id convention) — a photo can pull
// or push before or after its room row arrives. media already has a
// free-text `caption` column (surfaced as "Note" in the capture UI) —
// deliberately reused rather than adding a duplicate note column here.
export const migration = {
  version: 58,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    db.executeSync(`ALTER TABLE media ADD COLUMN room_id TEXT`);
  },
};
