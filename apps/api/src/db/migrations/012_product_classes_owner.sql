-- Migration 012: configurable product classes (taxonomy_types.meta) + conditional owner flag.
-- Fixed seed UUIDs for the 4 legacy measurement categories — MUST be identical on api + mobile.
--   liquid = 00000000-0000-4000-8000-000000000c01
--   piece  = 00000000-0000-4000-8000-000000000c02
--   length = 00000000-0000-4000-8000-000000000c03
--   weight = 00000000-0000-4000-8000-000000000c04

ALTER TABLE taxonomy_types ADD COLUMN IF NOT EXISTS meta TEXT;

ALTER TABLE locations ADD COLUMN IF NOT EXISTS subareas_require_owner BOOLEAN NOT NULL DEFAULT FALSE;

-- Seed 4 product_class rows by fixed UUID (idempotent). meta JSON carries curated units +
-- allowDecimals copied from apps/mobile/src/constants/units.ts (UNIT_OPTIONS / ALLOWS_DECIMALS).
INSERT INTO taxonomy_types (id, category, label, icon, sort_order, active, meta)
VALUES ('00000000-0000-4000-8000-000000000c01', 'product_class', 'Liquid', NULL, 0, TRUE,
        '{"units":["gallon","quart","pint","cup","fl oz","liter","ml"],"allowDecimals":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO taxonomy_types (id, category, label, icon, sort_order, active, meta)
VALUES ('00000000-0000-4000-8000-000000000c02', 'product_class', 'Pieces', NULL, 1, TRUE,
        '{"units":["each","pair","box","case","pack","set","roll"],"allowDecimals":false}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO taxonomy_types (id, category, label, icon, sort_order, active, meta)
VALUES ('00000000-0000-4000-8000-000000000c03', 'product_class', 'Length', NULL, 2, TRUE,
        '{"units":["ft","in","yd","m","cm"],"allowDecimals":true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO taxonomy_types (id, category, label, icon, sort_order, active, meta)
VALUES ('00000000-0000-4000-8000-000000000c04', 'product_class', 'Weight', NULL, 3, TRUE,
        '{"units":["lb","oz","kg","g"],"allowDecimals":true}')
ON CONFLICT (id) DO NOTHING;

-- Remap items from the 4 legacy enum keys to the fixed class UUIDs (idempotent — re-running matches nothing).
UPDATE inventory_items SET unit_category = '00000000-0000-4000-8000-000000000c01' WHERE unit_category = 'liquid';
UPDATE inventory_items SET unit_category = '00000000-0000-4000-8000-000000000c02' WHERE unit_category = 'piece';
UPDATE inventory_items SET unit_category = '00000000-0000-4000-8000-000000000c03' WHERE unit_category = 'length';
UPDATE inventory_items SET unit_category = '00000000-0000-4000-8000-000000000c04' WHERE unit_category = 'weight';
