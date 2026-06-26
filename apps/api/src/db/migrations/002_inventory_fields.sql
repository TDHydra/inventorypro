-- Migration 002: extra inventory item fields
-- SKU/part number, supplier/vendor, color/model variant, and a reorder-to level
-- that complements the existing min_qty_alert.

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS sku        TEXT,
  ADD COLUMN IF NOT EXISTS supplier   TEXT,
  ADD COLUMN IF NOT EXISTS model      TEXT,
  ADD COLUMN IF NOT EXISTS reorder_to DECIMAL(10,3);

CREATE INDEX IF NOT EXISTS items_sku_idx ON inventory_items(sku);
