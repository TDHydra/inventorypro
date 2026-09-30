import type { SqlDb } from '../types';

// Migration 029: taxonomy label→FK cutover (Phase 1, #74). Mirrors API migration
// 035. Adds a nullable soft-reference id beside each taxonomy LABEL column on the
// core-4 entity tables + backfills by (category,label). No FK constraint (SQLite
// wouldn't enforce cross-table over an unordered sync anyway); the label stays as
// a display cache, the id is the durable anchor so renames don't orphan. Backfill
// is deterministic when duplicate labels exist (active first, then sort_order).
export const migration = {
  version: 29,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE teams ADD COLUMN type_id TEXT`);
    db.executeSync(`ALTER TABLE jobs ADD COLUMN type_id TEXT`);
    db.executeSync(`ALTER TABLE inventory_items ADD COLUMN category_id TEXT`);
    db.executeSync(`ALTER TABLE locations ADD COLUMN type_id TEXT`);

    db.executeSync(`UPDATE teams SET type_id = (
      SELECT tt.id FROM taxonomy_types tt
      WHERE tt.category = 'team' AND tt.label = teams.type
      ORDER BY tt.active DESC, tt.sort_order ASC, tt.id ASC LIMIT 1
    ) WHERE type IS NOT NULL AND type_id IS NULL`);

    db.executeSync(`UPDATE jobs SET type_id = (
      SELECT tt.id FROM taxonomy_types tt
      WHERE tt.category = 'job' AND tt.label = jobs.type
      ORDER BY tt.active DESC, tt.sort_order ASC, tt.id ASC LIMIT 1
    ) WHERE type IS NOT NULL AND type_id IS NULL`);

    db.executeSync(`UPDATE inventory_items SET category_id = (
      SELECT tt.id FROM taxonomy_types tt
      WHERE tt.category = 'item_category' AND tt.label = inventory_items.category
      ORDER BY tt.active DESC, tt.sort_order ASC, tt.id ASC LIMIT 1
    ) WHERE category IS NOT NULL AND category_id IS NULL`);

    db.executeSync(`UPDATE locations SET type_id = (
      SELECT tt.id FROM taxonomy_types tt
      WHERE tt.category = 'location_type' AND tt.label = locations.type
      ORDER BY tt.active DESC, tt.sort_order ASC, tt.id ASC LIMIT 1
    ) WHERE type IS NOT NULL AND type_id IS NULL`);

    db.executeSync(`CREATE INDEX IF NOT EXISTS teams_type_id_idx ON teams(type_id)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS jobs_type_id_idx ON jobs(type_id)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS inventory_items_category_id_idx ON inventory_items(category_id)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS locations_type_id_idx ON locations(type_id)`);
  },
};
