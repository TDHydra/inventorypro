-- Migration 021: repair tickets + repair_status taxonomy.
--   repairs attach to an equipment unit, a general item, or a vehicle (location of
--   type Vehicle). entity_id has NO foreign key (sync-order safety). completed_at
--   is set when the ticket reaches a terminal status.
CREATE TABLE IF NOT EXISTS repairs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT NOT NULL,          -- 'equipment_unit' | 'item' | 'location'
  entity_id    UUID NOT NULL,
  entity_label TEXT,
  notes        TEXT,
  parts_needed TEXT,
  status       TEXT NOT NULL,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Seed the admin-editable repair_status taxonomy. meta.terminal = "counts as
-- completed" (returns equipment to available + stamps completed_at).
INSERT INTO taxonomy_types (category, label, icon, sort_order, meta)
SELECT 'repair_status', 'Open', '🆕', 0, '{"terminal":false}'
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'repair_status' AND label = 'Open');

INSERT INTO taxonomy_types (category, label, icon, sort_order, meta)
SELECT 'repair_status', 'Awaiting Parts', '📦', 1, '{"terminal":false}'
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'repair_status' AND label = 'Awaiting Parts');

INSERT INTO taxonomy_types (category, label, icon, sort_order, meta)
SELECT 'repair_status', 'In Progress', '🔧', 2, '{"terminal":false}'
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'repair_status' AND label = 'In Progress');

INSERT INTO taxonomy_types (category, label, icon, sort_order, meta)
SELECT 'repair_status', 'Repaired', '✅', 3, '{"terminal":true}'
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'repair_status' AND label = 'Repaired');

INSERT INTO taxonomy_types (category, label, icon, sort_order, meta)
SELECT 'repair_status', 'Cannot Repair', '❌', 4, '{"terminal":true}'
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'repair_status' AND label = 'Cannot Repair');
