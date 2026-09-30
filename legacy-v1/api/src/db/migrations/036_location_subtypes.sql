-- Migration 036: sub-area (child location) types. A location with a PARENT is a
-- sub-area, and its type picker offers these SUB-AREA types (Closet, Section,
-- Storage, Shelf, Area, Bin, Rack) instead of the top-level location_type list
-- (Shop, Vehicle, Warehouse, …). Managed in Manage Types as its own category.
--
-- Seeded with FIXED UUIDs (not gen_random_uuid) so the matching mobile migration
-- 030 can seed the SAME primary keys and both sides converge on sync — same id →
-- pull upsert is a no-op, no duplicate rows. Idempotent by id (INSERT … WHERE NOT
-- EXISTS); active defaults TRUE, updated_at defaults NOW().

INSERT INTO taxonomy_types (id, category, label, icon, sort_order)
SELECT 'f5b0a5e0-0000-4000-8000-000000000001', 'location_subtype', 'Closet', '🚪', 0
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'f5b0a5e0-0000-4000-8000-000000000001');

INSERT INTO taxonomy_types (id, category, label, icon, sort_order)
SELECT 'f5b0a5e0-0000-4000-8000-000000000002', 'location_subtype', 'Section', '🗂️', 1
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'f5b0a5e0-0000-4000-8000-000000000002');

INSERT INTO taxonomy_types (id, category, label, icon, sort_order)
SELECT 'f5b0a5e0-0000-4000-8000-000000000003', 'location_subtype', 'Storage', '📦', 2
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'f5b0a5e0-0000-4000-8000-000000000003');

INSERT INTO taxonomy_types (id, category, label, icon, sort_order)
SELECT 'f5b0a5e0-0000-4000-8000-000000000004', 'location_subtype', 'Shelf', '🗄️', 3
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'f5b0a5e0-0000-4000-8000-000000000004');

INSERT INTO taxonomy_types (id, category, label, icon, sort_order)
SELECT 'f5b0a5e0-0000-4000-8000-000000000005', 'location_subtype', 'Area', '📍', 4
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'f5b0a5e0-0000-4000-8000-000000000005');

INSERT INTO taxonomy_types (id, category, label, icon, sort_order)
SELECT 'f5b0a5e0-0000-4000-8000-000000000006', 'location_subtype', 'Bin', '🧺', 5
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'f5b0a5e0-0000-4000-8000-000000000006');

INSERT INTO taxonomy_types (id, category, label, icon, sort_order)
SELECT 'f5b0a5e0-0000-4000-8000-000000000007', 'location_subtype', 'Rack', '🗃️', 6
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE id = 'f5b0a5e0-0000-4000-8000-000000000007');
