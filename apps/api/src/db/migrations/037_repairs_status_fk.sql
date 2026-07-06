-- Migration 037: repairs.status label→FK cutover (#74 Phase 3b). Mirrors the
-- Phase 1 pattern (migration 035) for one more taxonomy-backed column: adds a
-- nullable soft-reference `status_id` beside the `status` LABEL cache and backfills
-- it by (category='repair_status', label). No FK constraint (an unordered sync
-- could deliver a repair before its taxonomy_types row); the label stays a display
-- cache, the id is the durable anchor so renaming a repair status doesn't orphan.
-- Backfill is deterministic when duplicate labels exist (active first, then sort_order).

ALTER TABLE repairs ADD COLUMN IF NOT EXISTS status_id UUID;

UPDATE repairs SET status_id = (
  SELECT tt.id FROM taxonomy_types tt
  WHERE tt.category = 'repair_status' AND tt.label = repairs.status
  ORDER BY tt.active DESC, tt.sort_order ASC, tt.id ASC LIMIT 1
) WHERE status IS NOT NULL AND status_id IS NULL;

CREATE INDEX IF NOT EXISTS repairs_status_id_idx ON repairs(status_id);
