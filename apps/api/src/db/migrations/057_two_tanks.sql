-- Migration 057: two-tank vehicle state (#122 Phase A1). Mirrors mobile 045.
-- water_state stays as a dead column (old APKs still write it; nothing reads it
-- after Phase A2). TEXT, never a PG enum (prod crash-loop trap).
--   water_tank: 'full' | 'empty'
--   waste_tank: 'dirty' | 'clean'  (clean = emptied + cleaned + filter replaced)
-- Backfill: 'full' → water_tank='full'; 'empty_clean' → the column defaults
-- (water empty + waste clean) already say it. Changed rows get updated_at=NOW()
-- so enrolled devices pick them up on incremental pull (watermark rule).
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS water_tank TEXT NOT NULL DEFAULT 'empty';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS waste_tank TEXT NOT NULL DEFAULT 'clean';
UPDATE vehicles SET water_tank = 'full', updated_at = NOW()
 WHERE water_state = 'full';
