-- Migration 082: mark item categories as repair parts, and seed "Equipment Part".
--
-- The repair ticket's "Use parts" sheet searched the ENTIRE item catalog, so a
-- tech looking for a blower wheel scrolled past chemicals, PPE and equipment.
-- Scope it to categories the admin marks as parts.
--
-- No schema change: taxonomy_types.meta is already a JSON text column that
-- round-trips through every upsert and the /sync/pull, so the flag rides along
-- exactly like item_category's existing `units`/`classId`/`color` keys and
-- repair_status's `terminal`. Mobile reads it via parseItemTypeMeta().parts and
-- writes it from Manage Types ("Use for repair parts" switch).
--
-- Idempotent by (category, label), matching the 011/017/068 seed pattern.
-- updated_at = NOW() is explicit so already-enrolled devices receive the row
-- via incremental /sync/pull (the seed-sync watermark trap, per 048/068).
-- NOTE: a device that pulls between this migration and its own next pull still
-- needs `UPDATE taxonomy_types SET updated_at = NOW() WHERE category =
-- 'item_category' AND label = 'Equipment Part';` to be re-delivered — run that
-- after deploy if the category doesn't appear on an existing device.

INSERT INTO taxonomy_types (category, label, icon, sort_order, meta, updated_at)
SELECT 'item_category', 'Equipment Part', '🔧', 5,
       -- classId = the 'Pieces' product class (parts are counted, not poured),
       -- resolved by label so this matches whatever id migration 012 minted.
       jsonb_build_object(
         'units', jsonb_build_array('each', 'box', 'pack', 'set'),
         'classId', (SELECT id::text FROM taxonomy_types
                     WHERE category = 'product_class' AND label = 'Pieces'
                     ORDER BY active DESC, sort_order ASC, id ASC LIMIT 1),
         'parts', true
       )::text,
       NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM taxonomy_types
  WHERE category = 'item_category' AND label = 'Equipment Part'
);
