import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSqlJsDb } from './sqljsTestDb';
import { migration } from './047_flatten_and_dedupe';
import type { SqlDb } from '../types';

let db: SqlDb;
const T = '2026-07-01T00:00:00.000Z';
before(async () => {
  db = await makeSqlJsDb();
  db.executeSync(`CREATE TABLE locations (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, type TEXT, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, synced_at TEXT)`);
  db.executeSync(`CREATE TABLE stock_by_location (item_id TEXT NOT NULL, location_id TEXT NOT NULL, quantity REAL NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT, PRIMARY KEY (item_id, location_id))`);
  db.executeSync(`CREATE TABLE vehicle_checkouts (id TEXT PRIMARY KEY, vehicle_location_id TEXT NOT NULL, user_id TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.executeSync(`CREATE TABLE vehicle_service_records (id TEXT PRIMARY KEY, vehicle_location_id TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.executeSync(`CREATE TABLE equipment_units (id TEXT PRIMARY KEY, current_location_id TEXT, updated_at TEXT NOT NULL)`);
  db.executeSync(`CREATE TABLE vehicles (location_id TEXT PRIMARY KEY, truck_mount INTEGER NOT NULL DEFAULT 0, water_state TEXT, model TEXT, model_id TEXT, notes TEXT, updated_at TEXT NOT NULL, synced_at TEXT, water_tank TEXT NOT NULL DEFAULT 'empty', waste_tank TEXT NOT NULL DEFAULT 'clean')`);
  db.executeSync(`CREATE TABLE unit_access (location_id TEXT NOT NULL, user_id TEXT NOT NULL, can_view INTEGER NOT NULL DEFAULT 1, can_add INTEGER NOT NULL DEFAULT 0, can_remove INTEGER NOT NULL DEFAULT 0, can_move INTEGER NOT NULL DEFAULT 0, can_edit_details INTEGER NOT NULL DEFAULT 0, can_grant INTEGER NOT NULL DEFAULT 0, granted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT, PRIMARY KEY (location_id, user_id))`);
  const loc = (id: string, name: string, parent: string | null, type: string | null, updated = T) =>
    db.executeSync(`INSERT INTO locations (id, name, parent_id, type, active, updated_at) VALUES (?,?,?,?,1,?)`, [id, name, parent, type, updated]);
  // Construction van with a room and a shelf inside the room, each with stock.
  loc('van-c', 'Construction Van', null, 'Vehicle');
  loc('room-1', 'Back Shelving', 'van-c', 'Room');
  loc('shelf-1', 'Bin A', 'room-1', 'Shelf');
  db.executeSync(`INSERT INTO stock_by_location VALUES ('item-1', 'van-c', 2, ?, NULL), ('item-1', 'room-1', 3, ?, NULL), ('item-1', 'shelf-1', 5, ?, NULL)`, [T, T, T]);
  // Duplicate vehicles: 'Van 7' (older → survivor) and ' van 7 ' (dup).
  loc('veh-old', 'Van 7', null, 'Vehicle', '2026-06-01T00:00:00.000Z');
  loc('veh-dup', ' van 7 ', null, 'Vehicle', '2026-07-10T00:00:00.000Z');
  db.executeSync(`INSERT INTO stock_by_location VALUES ('item-2', 'veh-dup', 4, ?, NULL)`, [T]);
  db.executeSync(`INSERT INTO vehicle_checkouts VALUES ('co-1', 'veh-dup', 'user-a', ?)`, [T]);
  db.executeSync(`INSERT INTO vehicle_service_records VALUES ('sr-1', 'veh-dup', ?)`, [T]);
  db.executeSync(`INSERT INTO equipment_units VALUES ('eq-1', 'veh-dup', ?)`, [T]);
  db.executeSync(`INSERT INTO vehicles (location_id, truck_mount, updated_at) VALUES ('veh-dup', 1, ?)`, [T]);
  migration.up(db);
});

test('047 flatten: descendant stock summed onto the van, children zeroed and retired', () => {
  assert.equal(db.executeSync(`SELECT quantity FROM stock_by_location WHERE item_id='item-1' AND location_id='van-c'`).rows[0]!.quantity, 10);
  assert.equal(db.executeSync(`SELECT SUM(quantity) AS q FROM stock_by_location WHERE location_id IN ('room-1','shelf-1')`).rows[0]!.q, 0);
  assert.equal(db.executeSync(`SELECT COUNT(*) AS n FROM locations WHERE id IN ('room-1','shelf-1') AND active = 0`).rows[0]!.n, 2);
});

test('047 dedupe: oldest normalized-name vehicle survives; refs re-pointed; dup retired', () => {
  assert.equal(db.executeSync(`SELECT active FROM locations WHERE id='veh-dup'`).rows[0]!.active, 0);
  assert.equal(db.executeSync(`SELECT active FROM locations WHERE id='veh-old'`).rows[0]!.active, 1);
  assert.equal(db.executeSync(`SELECT quantity FROM stock_by_location WHERE item_id='item-2' AND location_id='veh-old'`).rows[0]!.quantity, 4);
  assert.equal(db.executeSync(`SELECT vehicle_location_id FROM vehicle_checkouts WHERE id='co-1'`).rows[0]!.vehicle_location_id, 'veh-old');
  assert.equal(db.executeSync(`SELECT vehicle_location_id FROM vehicle_service_records WHERE id='sr-1'`).rows[0]!.vehicle_location_id, 'veh-old');
  assert.equal(db.executeSync(`SELECT current_location_id FROM equipment_units WHERE id='eq-1'`).rows[0]!.current_location_id, 'veh-old');
  assert.equal(db.executeSync(`SELECT truck_mount FROM vehicles WHERE location_id='veh-old'`).rows[0]!.truck_mount, 1); // adopted (survivor had none)
  assert.equal(db.executeSync(`SELECT COUNT(*) AS n FROM vehicles WHERE location_id='veh-dup'`).rows[0]!.n, 0);
});
