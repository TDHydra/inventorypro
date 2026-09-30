ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS returnable BOOLEAN NOT NULL DEFAULT FALSE;
-- Sensible backfill: existing equipment defaults to returnable.
UPDATE inventory_items SET returnable = TRUE WHERE kind = 'equipment';
