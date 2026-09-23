-- Migration 020: item pack size (entry helper).
--   inventory_items.pack_size — how many BASE units come in one pack (e.g. SERVPRO
--   Orange = 4 gal/pack → pack_size 4, unit 'gallon'; #202 = a dozen cans → 12).
--   Stock is still tracked in the base unit; pack_size only multiplies pack entry.
--   NULL = no pack concept (add by the base unit only).
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS pack_size INTEGER;
