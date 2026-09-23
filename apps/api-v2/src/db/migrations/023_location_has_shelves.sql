-- Migration 023: per-location "has shelves" flag. When ON, the add-stock screen
-- lets you type/pick a shelf within that location; the shelf is a child location
-- (type 'Shelf') and stock is tracked against it (a tracked sub-spot).
ALTER TABLE locations ADD COLUMN IF NOT EXISTS has_shelves BOOLEAN NOT NULL DEFAULT FALSE;
