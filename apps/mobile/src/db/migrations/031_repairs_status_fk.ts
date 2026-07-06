import type { SqlDb } from '../types';

// Migration 031: repairs.status label→FK cutover (#74 Phase 3b). Mirrors API
// migration 037 and the Phase 1 pattern (migration 029). Adds a nullable soft-
// reference `status_id` beside the `status` LABEL cache on repairs + backfills by
// (category='repair_status', label). No FK constraint; the label stays a display
// cache, the id is the durable anchor so a repair-status rename doesn't orphan.
// Backfill is deterministic when duplicate labels exist (active first, then sort_order).
export const migration = {
  version: 31,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE repairs ADD COLUMN status_id TEXT`);

    db.executeSync(`UPDATE repairs SET status_id = (
      SELECT tt.id FROM taxonomy_types tt
      WHERE tt.category = 'repair_status' AND tt.label = repairs.status
      ORDER BY tt.active DESC, tt.sort_order ASC, tt.id ASC LIMIT 1
    ) WHERE status IS NOT NULL AND status_id IS NULL`);

    db.executeSync(`CREATE INDEX IF NOT EXISTS repairs_status_id_idx ON repairs(status_id)`);
  },
};
