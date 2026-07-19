import type { SqlDb } from '../types';

// Migration 044: on-call calendar (#128). Mirrors API migration 056.
// One crew (subteam) covers each week. UNIQUE(week_start) matters locally too:
// the server upserts on week_start (a reassignment may arrive with a NEW id for
// the same week), and pull's INSERT OR REPLACE resolves the UNIQUE conflict by
// replacing the superseded row — without it a reassignment would duplicate.
// week_start is the ISO date (yyyy-mm-dd) of the week's Monday (weekMath.ts).
export const migration = {
  version: 44,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS on_call_shifts (
      id TEXT PRIMARY KEY,
      subteam_id TEXT,
      week_start TEXT NOT NULL UNIQUE,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
  },
};
