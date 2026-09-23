-- Migration 059 (#122 Phase A1, bug #129): flatten Vehicle/Locker sub-areas
-- (construction van) and merge duplicate Vehicle locations by normalized name.
-- Mirrors mobile 047. Every touched row gets updated_at = NOW() (watermark) so
-- enrolled devices converge on incremental pull; deletes below only hit rows
-- whose parent location is simultaneously retired, so stale client copies are
-- unreachable rather than wrong.

-- ── 1. Flatten: no sub-areas under vehicles/lockers ─────────────────────────
CREATE TEMP TABLE unit_children AS
WITH RECURSIVE uc AS (
  SELECT c.id, c.parent_id AS unit_id
    FROM locations c JOIN locations p ON p.id = c.parent_id
   WHERE p.type IN ('Vehicle', 'Locker')
  UNION ALL
  SELECT c.id, uc.unit_id FROM locations c JOIN uc ON c.parent_id = uc.id
)
SELECT id, unit_id FROM uc;

INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
SELECT s.item_id, uc.unit_id, SUM(s.quantity), NOW()
  FROM stock_by_location s JOIN unit_children uc ON s.location_id = uc.id
 WHERE s.quantity <> 0
 GROUP BY s.item_id, uc.unit_id
ON CONFLICT (item_id, location_id) DO UPDATE
   SET quantity = stock_by_location.quantity + EXCLUDED.quantity, updated_at = NOW();

UPDATE stock_by_location SET quantity = 0, updated_at = NOW()
 WHERE location_id IN (SELECT id FROM unit_children) AND quantity <> 0;

UPDATE locations SET active = FALSE, updated_at = NOW()
 WHERE id IN (SELECT id FROM unit_children) AND active = TRUE;

-- ── 2. Dedupe: one active Vehicle location per LOWER(TRIM(name)) ────────────
-- Survivor = oldest updated_at, tiebreak id::text (text compare matches SQLite).
CREATE TEMP TABLE vehicle_dupes AS
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(name)) ORDER BY updated_at ASC, id::text ASC) AS rn,
         FIRST_VALUE(id) OVER (PARTITION BY LOWER(TRIM(name)) ORDER BY updated_at ASC, id::text ASC) AS survivor_id
    FROM locations
   WHERE type = 'Vehicle' AND active = TRUE
)
SELECT id AS dup_id, survivor_id FROM ranked WHERE rn > 1;

INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
SELECT s.item_id, d.survivor_id, SUM(s.quantity), NOW()
  FROM stock_by_location s JOIN vehicle_dupes d ON s.location_id = d.dup_id
 WHERE s.quantity <> 0
 GROUP BY s.item_id, d.survivor_id
ON CONFLICT (item_id, location_id) DO UPDATE
   SET quantity = stock_by_location.quantity + EXCLUDED.quantity, updated_at = NOW();

UPDATE stock_by_location SET quantity = 0, updated_at = NOW()
 WHERE location_id IN (SELECT dup_id FROM vehicle_dupes) AND quantity <> 0;

UPDATE vehicle_checkouts vc SET vehicle_location_id = d.survivor_id, updated_at = NOW()
  FROM vehicle_dupes d WHERE vc.vehicle_location_id = d.dup_id;

UPDATE vehicle_service_records r SET vehicle_location_id = d.survivor_id, updated_at = NOW()
  FROM vehicle_dupes d WHERE r.vehicle_location_id = d.dup_id;

UPDATE equipment_units e SET current_location_id = d.survivor_id, updated_at = NOW()
  FROM vehicle_dupes d WHERE e.current_location_id = d.dup_id;

-- vehicles extension row: survivor's wins; adopt the dup's only when absent.
INSERT INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, water_tank, waste_tank)
SELECT d.survivor_id, v.truck_mount, v.water_state, v.model, v.model_id, v.notes, NOW(), v.water_tank, v.waste_tank
  FROM vehicles v JOIN vehicle_dupes d ON v.location_id = d.dup_id
ON CONFLICT (location_id) DO NOTHING;
DELETE FROM vehicles WHERE location_id IN (SELECT dup_id FROM vehicle_dupes);

-- Grants move to the survivor; an existing survivor grant wins.
INSERT INTO unit_access (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at)
SELECT d.survivor_id, ua.user_id, ua.can_view, ua.can_add, ua.can_remove, ua.can_move, ua.can_edit_details, ua.can_grant, ua.granted_by, ua.created_at, NOW()
  FROM unit_access ua JOIN vehicle_dupes d ON ua.location_id = d.dup_id
ON CONFLICT (location_id, user_id) DO NOTHING;
DELETE FROM unit_access WHERE location_id IN (SELECT dup_id FROM vehicle_dupes);

UPDATE locations SET active = FALSE, updated_at = NOW()
 WHERE id IN (SELECT dup_id FROM vehicle_dupes);

DROP TABLE unit_children;
DROP TABLE vehicle_dupes;
