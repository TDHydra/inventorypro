import type { SqlDb } from '../types';

// Migration 047 (#122 Phase A1, #129): SQLite mirror of API 059 — flatten
// Vehicle/Locker sub-areas, dedupe Vehicle locations by LOWER(TRIM(name)).
// Survivor ordering (updated_at ASC, id ASC) matches PG's (updated_at, id::text)
// so both sides pick the SAME survivor and converge without conflict. No outbox
// writes — the server runs 059 itself.
export const migration = {
  version: 47,
  up: (db: SqlDb): void => {
    const now = new Date().toISOString();
    // ── 1. Flatten ──────────────────────────────────────────────────────────
    db.executeSync(`CREATE TEMP TABLE unit_children AS
      WITH RECURSIVE uc(id, unit_id) AS (
        SELECT c.id, c.parent_id FROM locations c
          JOIN locations p ON p.id = c.parent_id
         WHERE p.type IN ('Vehicle', 'Locker')
        UNION ALL
        SELECT c.id, uc.unit_id FROM locations c JOIN uc ON c.parent_id = uc.id
      )
      SELECT id, unit_id FROM uc`);
    db.executeSync(
      `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
       SELECT s.item_id, uc.unit_id, SUM(s.quantity), ?
         FROM stock_by_location s JOIN unit_children uc ON s.location_id = uc.id
        WHERE s.quantity <> 0
        GROUP BY s.item_id, uc.unit_id
       ON CONFLICT (item_id, location_id) DO UPDATE
          SET quantity = quantity + excluded.quantity, updated_at = excluded.updated_at`,
      [now],
    );
    db.executeSync(`UPDATE stock_by_location SET quantity = 0, updated_at = ? WHERE location_id IN (SELECT id FROM unit_children) AND quantity <> 0`, [now]);
    db.executeSync(`UPDATE locations SET active = 0, updated_at = ? WHERE id IN (SELECT id FROM unit_children) AND active = 1`, [now]);
    // ── 2. Dedupe vehicles ─────────────────────────────────────────────────
    db.executeSync(`CREATE TEMP TABLE vehicle_dupes AS
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(name)) ORDER BY updated_at ASC, id ASC) AS rn,
               FIRST_VALUE(id) OVER (PARTITION BY LOWER(TRIM(name)) ORDER BY updated_at ASC, id ASC) AS survivor_id
          FROM locations WHERE type = 'Vehicle' AND active = 1
      )
      SELECT id AS dup_id, survivor_id FROM ranked WHERE rn > 1`);
    db.executeSync(
      `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
       SELECT s.item_id, d.survivor_id, SUM(s.quantity), ?
         FROM stock_by_location s JOIN vehicle_dupes d ON s.location_id = d.dup_id
        WHERE s.quantity <> 0
        GROUP BY s.item_id, d.survivor_id
       ON CONFLICT (item_id, location_id) DO UPDATE
          SET quantity = quantity + excluded.quantity, updated_at = excluded.updated_at`,
      [now],
    );
    db.executeSync(`UPDATE stock_by_location SET quantity = 0, updated_at = ? WHERE location_id IN (SELECT dup_id FROM vehicle_dupes) AND quantity <> 0`, [now]);
    db.executeSync(`UPDATE vehicle_checkouts SET vehicle_location_id = (SELECT survivor_id FROM vehicle_dupes WHERE dup_id = vehicle_location_id), updated_at = ? WHERE vehicle_location_id IN (SELECT dup_id FROM vehicle_dupes)`, [now]);
    db.executeSync(`UPDATE vehicle_service_records SET vehicle_location_id = (SELECT survivor_id FROM vehicle_dupes WHERE dup_id = vehicle_location_id), updated_at = ? WHERE vehicle_location_id IN (SELECT dup_id FROM vehicle_dupes)`, [now]);
    db.executeSync(`UPDATE equipment_units SET current_location_id = (SELECT survivor_id FROM vehicle_dupes WHERE dup_id = current_location_id), updated_at = ? WHERE current_location_id IN (SELECT dup_id FROM vehicle_dupes)`, [now]);
    db.executeSync(
      `INSERT OR IGNORE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, synced_at, water_tank, waste_tank)
       SELECT d.survivor_id, v.truck_mount, v.water_state, v.model, v.model_id, v.notes, ?, NULL, v.water_tank, v.waste_tank
         FROM vehicles v JOIN vehicle_dupes d ON v.location_id = d.dup_id`,
      [now],
    );
    db.executeSync(`DELETE FROM vehicles WHERE location_id IN (SELECT dup_id FROM vehicle_dupes)`);
    db.executeSync(
      `INSERT OR IGNORE INTO unit_access (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at, synced_at)
       SELECT d.survivor_id, ua.user_id, ua.can_view, ua.can_add, ua.can_remove, ua.can_move, ua.can_edit_details, ua.can_grant, ua.granted_by, ua.created_at, ?, NULL
         FROM unit_access ua JOIN vehicle_dupes d ON ua.location_id = d.dup_id`,
      [now],
    );
    db.executeSync(`DELETE FROM unit_access WHERE location_id IN (SELECT dup_id FROM vehicle_dupes)`);
    db.executeSync(`UPDATE locations SET active = 0, updated_at = ? WHERE id IN (SELECT dup_id FROM vehicle_dupes)`, [now]);
    db.executeSync(`DROP TABLE unit_children`);
    db.executeSync(`DROP TABLE vehicle_dupes`);
  },
};
