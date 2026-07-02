import type { SqlDb } from '../types';

// Migration 028: label_templates — org-synced custom label layouts for the visual
// label designer. Mirrors API migration 034. `fields` is a JSON string (array of
// positioned LabelField, see src/labels/positioned.ts), stored as TEXT exactly
// like taxonomy_types.meta. `synced_at` is local-only (stripped from the outbox).
export const migration = {
  version: 28,
  up: (db: SqlDb): void => {
    db.executeSync(`CREATE TABLE IF NOT EXISTS label_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      width_in REAL NOT NULL,
      height_in REAL NOT NULL,
      dpi INTEGER NOT NULL DEFAULT 203,
      fields TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    )`);
  },
};
