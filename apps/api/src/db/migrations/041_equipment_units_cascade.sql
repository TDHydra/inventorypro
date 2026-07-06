-- Migration 041: equipment_units.item_id → ON DELETE CASCADE.
-- Deleting an inventory_item now cleanly removes its tracked units server-side
-- (matching stock_by_location's existing cascade from migration 001), so the
-- generic sync DELETE path (routes/sync.ts) can remove equipment items without a
-- foreign-key violation. Enables the bulk-delete feature + the catalog cleanup.
-- maintenance_events.unit_id has NO FK (sync-order-safe, migration 033), so its
-- rows simply orphan on delete — harmless; the cleanup removes them explicitly.
ALTER TABLE equipment_units DROP CONSTRAINT IF EXISTS equipment_units_item_id_fkey;
ALTER TABLE equipment_units
  ADD CONSTRAINT equipment_units_item_id_fkey
  FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
