-- Migration 019: location types + item home location.
--   locations.type            — a location_type taxonomy label (Shop, Vehicle, Locker, …)
--   inventory_items.home_location_id — where an item belongs (often a shelf); nullable,
--     NO foreign key so out-of-order sync (item before its location) can't be rejected.
-- Seeds the location_type taxonomy (idempotent by category+label, per migration 011 pattern).

ALTER TABLE locations ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS home_location_id UUID;

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'location_type', 'Shop', '🏪', 0
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'location_type' AND label = 'Shop');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'location_type', 'Vehicle', '🚐', 1
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'location_type' AND label = 'Vehicle');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'location_type', 'Locker', '🔒', 2
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'location_type' AND label = 'Locker');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'location_type', 'Maintenance', '🔧', 3
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'location_type' AND label = 'Maintenance');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'location_type', 'Warehouse', '🏭', 4
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'location_type' AND label = 'Warehouse');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'location_type', 'Job Site', '🚧', 5
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'location_type' AND label = 'Job Site');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'location_type', 'Shelf', '🗄️', 6
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'location_type' AND label = 'Shelf');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'location_type', 'Area', '📍', 7
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'location_type' AND label = 'Area');
