-- Migration 048: equipment type taxonomy (#28). Mirrors mobile migration 038.
-- Adds the label column (`type`, display cache) + the durable taxonomy FK
-- (`type_id`, soft reference — no constraint, same out-of-order-sync rationale
-- as migration 035) to inventory_items, and seeds the 'equipment' taxonomy
-- category (idempotent by category+label, per migration 019). No backfill: the
-- column is brand new, no legacy labels exist to resolve.
--
-- Seeds carry updated_at = NOW() explicitly so already-enrolled devices receive
-- them via incremental /sync/pull (the seed-sync watermark trap).

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS type    TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS type_id UUID;

CREATE INDEX IF NOT EXISTS inventory_items_type_id_idx ON inventory_items(type_id);

INSERT INTO taxonomy_types (category, label, icon, sort_order, updated_at)
SELECT 'equipment', 'Generator', '⚡', 0, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'equipment' AND label = 'Generator');

INSERT INTO taxonomy_types (category, label, icon, sort_order, updated_at)
SELECT 'equipment', 'Air Mover', '🌀', 1, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'equipment' AND label = 'Air Mover');

INSERT INTO taxonomy_types (category, label, icon, sort_order, updated_at)
SELECT 'equipment', 'Dehumidifier', '💨', 2, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'equipment' AND label = 'Dehumidifier');

INSERT INTO taxonomy_types (category, label, icon, sort_order, updated_at)
SELECT 'equipment', 'Vehicle', '🚐', 3, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'equipment' AND label = 'Vehicle');

INSERT INTO taxonomy_types (category, label, icon, sort_order, updated_at)
SELECT 'equipment', 'Power Tool', '🔧', 4, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'equipment' AND label = 'Power Tool');

INSERT INTO taxonomy_types (category, label, icon, sort_order, updated_at)
SELECT 'equipment', 'Other', '🗂️', 5, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'equipment' AND label = 'Other');
