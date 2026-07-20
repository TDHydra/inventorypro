import type { SqlDb } from '../types';

// Migration 049: users.phone — optional contact number (role-dashboards spec §4).
// Mirrors the API's users.phone migration. SYNCED column (see
// docs/SYNC-MIGRATION-CHECKLIST.md — pull.ts users TABLE_UPSERT_SQL/rowToValues
// and queries/users.ts upsertUser were extended in the same change). Nullable
// TEXT, stored normalized (optional leading '+', then 7–15 digits) — the format
// is enforced by validatePhone client-side and the API server-side, never at
// the DB layer. No SMS verification exists; this is display/contact data only.
export const migration = {
  version: 49,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE users ADD COLUMN phone TEXT`);
  },
};
