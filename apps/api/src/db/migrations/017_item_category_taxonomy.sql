-- Migration 017: seed the `item_category` taxonomy used to classify products in
-- quick-add (PPE, Filters, Consumables, Chemicals, General). Admin-manageable via
-- Manage Types. The selected label is stored in inventory_items.category; kind
-- stays 'product' (equipment has its own tab). Rows sync to devices via the
-- taxonomy_types pull (no mobile schema migration needed — only data).
-- Idempotent by (category, label), matching the migration 011 seed pattern.

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'item_category', 'PPE', '🦺', 0
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'item_category' AND label = 'PPE');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'item_category', 'Filters', '🌬️', 1
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'item_category' AND label = 'Filters');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'item_category', 'Consumables', '🧴', 2
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'item_category' AND label = 'Consumables');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'item_category', 'Chemicals', '🧪', 3
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'item_category' AND label = 'Chemicals');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'item_category', 'General', '📦', 4
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'item_category' AND label = 'General');
