-- Migration 018: give each item_category its curated unit list + the product_class
-- it maps to, so picking an Item Type in quick-add auto-sets the available units.
-- meta JSON shape: { "units": [...], "classId": "<product_class uuid>" }.
--   classId is stored as the item's unit_category (a real product_class id) so
--   formatQuantity's decimals policy keeps working unchanged.
-- product_class fixed UUIDs (migration 012): piece c02, liquid c01.

UPDATE taxonomy_types SET
  meta = '{"units":["each","pair","box","case","set"],"classId":"00000000-0000-4000-8000-000000000c02"}',
  updated_at = NOW()
WHERE category = 'item_category' AND label = 'PPE';

UPDATE taxonomy_types SET
  meta = '{"units":["each","box","case","pack"],"classId":"00000000-0000-4000-8000-000000000c02"}',
  updated_at = NOW()
WHERE category = 'item_category' AND label = 'Filters';

UPDATE taxonomy_types SET
  meta = '{"units":["each","box","case","pack","roll"],"classId":"00000000-0000-4000-8000-000000000c02"}',
  updated_at = NOW()
WHERE category = 'item_category' AND label = 'Consumables';

UPDATE taxonomy_types SET
  meta = '{"units":["gallon","quart","pint","fl oz","liter","ml"],"classId":"00000000-0000-4000-8000-000000000c01"}',
  updated_at = NOW()
WHERE category = 'item_category' AND label = 'Chemicals';

UPDATE taxonomy_types SET
  meta = '{"units":["each","box","case","pack"],"classId":"00000000-0000-4000-8000-000000000c02"}',
  updated_at = NOW()
WHERE category = 'item_category' AND label = 'General';
