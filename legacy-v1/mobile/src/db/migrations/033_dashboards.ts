import type { SqlDb } from '../types';

// Migration 033: configurable team/role-based dashboards (Wave B / D1). Mirrors
// API migration 039. `layout` is a JSON string (array of LayoutBlock, see
// src/dashboard/widgets.ts), stored as TEXT exactly like taxonomy_types.meta /
// label_templates.fields. All three are SYNCED (see docs/SYNC-MIGRATION-CHECKLIST.md
// — pull.ts TABLE_UPSERT_SQL/rowToValues, the users + role_settings upsert lists,
// sync.ts FULL_TABLES/ALLOWED_TABLES, syncPolicy, and fullDownload SYNC_TABLES were
// all updated in the same change).
//   dashboard_presets                  — org-shared dashboard layouts.
//   users.dashboard_preset_id          — per-user assignment (highest precedence).
//   role_settings.dashboard_preset_id  — per-role assignment (fallback).
// Nullable assignment columns; NULL → built-in DEFAULT_LAYOUT (unchanged dashboard).
export const migration = {
  version: 33,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS dashboard_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      layout TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )`);
    db.executeSync(`ALTER TABLE users ADD COLUMN dashboard_preset_id TEXT`);
    db.executeSync(`ALTER TABLE role_settings ADD COLUMN dashboard_preset_id TEXT`);
  },
};
