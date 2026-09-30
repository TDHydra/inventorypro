-- Migration 035: taxonomy label→FK cutover (Phase 1, #74). Adds a nullable
-- soft-reference *_id column beside each taxonomy LABEL column on the core-4
-- entity tables, and backfills it by (category,label) match.
--
-- NO hard FK constraint on purpose: a referential FK would reject an entity push
-- that arrives before its taxonomy_types row (the sync outbox is unordered) — the
-- same reason migration 024 dropped the UNIQUE(category,label) index. The label
-- columns stay (denormalized display cache + backward-compat for older app
-- builds); the id is the durable anchor so renaming a type no longer orphans its
-- entities. The backfill picks a deterministic row when duplicate labels exist
-- (active first, then lowest sort_order, then id).
ALTER TABLE teams            ADD COLUMN IF NOT EXISTS type_id     UUID;
ALTER TABLE jobs             ADD COLUMN IF NOT EXISTS type_id     UUID;
ALTER TABLE inventory_items  ADD COLUMN IF NOT EXISTS category_id UUID;
ALTER TABLE locations        ADD COLUMN IF NOT EXISTS type_id     UUID;

UPDATE teams t SET type_id = (
  SELECT tt.id FROM taxonomy_types tt
  WHERE tt.category = 'team' AND tt.label = t.type
  ORDER BY tt.active DESC, tt.sort_order ASC, tt.id ASC LIMIT 1
) WHERE t.type IS NOT NULL AND t.type_id IS NULL;

UPDATE jobs j SET type_id = (
  SELECT tt.id FROM taxonomy_types tt
  WHERE tt.category = 'job' AND tt.label = j.type
  ORDER BY tt.active DESC, tt.sort_order ASC, tt.id ASC LIMIT 1
) WHERE j.type IS NOT NULL AND j.type_id IS NULL;

UPDATE inventory_items i SET category_id = (
  SELECT tt.id FROM taxonomy_types tt
  WHERE tt.category = 'item_category' AND tt.label = i.category
  ORDER BY tt.active DESC, tt.sort_order ASC, tt.id ASC LIMIT 1
) WHERE i.category IS NOT NULL AND i.category_id IS NULL;

UPDATE locations l SET type_id = (
  SELECT tt.id FROM taxonomy_types tt
  WHERE tt.category = 'location_type' AND tt.label = l.type
  ORDER BY tt.active DESC, tt.sort_order ASC, tt.id ASC LIMIT 1
) WHERE l.type IS NOT NULL AND l.type_id IS NULL;

CREATE INDEX IF NOT EXISTS teams_type_id_idx               ON teams(type_id);
CREATE INDEX IF NOT EXISTS jobs_type_id_idx                ON jobs(type_id);
CREATE INDEX IF NOT EXISTS inventory_items_category_id_idx ON inventory_items(category_id);
CREATE INDEX IF NOT EXISTS locations_type_id_idx           ON locations(type_id);
