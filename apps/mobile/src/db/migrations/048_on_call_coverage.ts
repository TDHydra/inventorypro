import type { SqlDb } from '../types';

// Migration 048: on-call coverage/time-off (#122 Phase C). Mirrors API 060.
// Also re-keys existing Monday-keyed on_call_shifts to the Thursday boundary
// (guarded to %w='1' so rows already re-keyed via pull are untouched).
export const migration = {
  version: 48,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS on_call_coverage (
      id TEXT PRIMARY KEY,
      date_start TEXT NOT NULL,
      date_end TEXT NOT NULL,
      user_off TEXT,
      covering_user TEXT,
      note TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
    db.executeSync(
      `UPDATE on_call_shifts SET week_start = date(week_start, '-4 days')
        WHERE strftime('%w', week_start) = '1'`,
    );
  },
};
