-- Migration 022: per-location-type form rules (meta flags) so the location form
-- adapts to the chosen type. meta JSON: { "gps": bool, "requiresOwner": bool }.
--   gps=false → hide the GPS anchor (vehicles move; lockers/maintenance are at the shop)
--   requiresOwner=true → "Belongs to (Owner)" is required (a vehicle belongs to a PM)
-- Unflagged / custom types default to gps=true, requiresOwner=false in the app.

UPDATE taxonomy_types SET meta = '{"gps":true,"requiresOwner":false}', updated_at = NOW()
  WHERE category = 'location_type' AND label = 'Shop';
UPDATE taxonomy_types SET meta = '{"gps":false,"requiresOwner":true}', updated_at = NOW()
  WHERE category = 'location_type' AND label = 'Vehicle';
UPDATE taxonomy_types SET meta = '{"gps":false,"requiresOwner":false}', updated_at = NOW()
  WHERE category = 'location_type' AND label = 'Locker';
UPDATE taxonomy_types SET meta = '{"gps":false,"requiresOwner":false}', updated_at = NOW()
  WHERE category = 'location_type' AND label = 'Maintenance';
UPDATE taxonomy_types SET meta = '{"gps":true,"requiresOwner":false}', updated_at = NOW()
  WHERE category = 'location_type' AND label = 'Warehouse';
UPDATE taxonomy_types SET meta = '{"gps":true,"requiresOwner":false}', updated_at = NOW()
  WHERE category = 'location_type' AND label = 'Job Site';
UPDATE taxonomy_types SET meta = '{"gps":false,"requiresOwner":false}', updated_at = NOW()
  WHERE category = 'location_type' AND label = 'Shelf';
UPDATE taxonomy_types SET meta = '{"gps":false,"requiresOwner":false}', updated_at = NOW()
  WHERE category = 'location_type' AND label = 'Area';
