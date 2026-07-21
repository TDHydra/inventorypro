import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Vehicle retire/reactivate (#153): exercise the REAL locations.ts helpers
// (retireVehicle/reactivateVehicle) against an in-memory sql.js database.
// locations.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding, utils/uuid imports react-native-get-random-values,
// and log.ts pulls telemetry (expo-constants / react-native). Same
// Module._load intercept as vehiclesLock.test.ts / personalLocker.test.ts —
// db/schema becomes a real sql.js database (locationsShelf.testdb.ts).
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./locationsShelf.testdb') as typeof import('./locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  // Side-effect-only crypto polyfill; node already has crypto.getRandomValues.
  if (request === 'react-native-get-random-values') return {};
  // The GPS-stamping log path (#33) transitively imports expo-location, which
  // pulls in expo / expo-modules-core / react-native — none of which parse under
  // tsx/esbuild (react-native/index.js is Flow-typed) or run outside Metro. These
  // tests never exercise GPS, so hand back a benign no-op stub for each; every
  // property access returns a no-op fn so any polyfill init on load stays inert.
  if (request === 'react-native' || request === 'expo' || request === 'expo-modules-core') {
    return new Proxy({ __esModule: true }, { get: (_t, p) => (p === '__esModule' ? true : () => {}) });
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  if (resolved.endsWith('/src/telemetry/index.ts')) return { track() {} };
  return origLoad.call(this, request, parent, isMain);
};

let loc: typeof import('./locations');

function db() { return testDb.getDb(); }

function locationRow(id: string): Record<string, unknown> {
  return db().executeSync(`SELECT * FROM locations WHERE id = ?`, [id]).rows[0] as Record<string, unknown>;
}

function lastLocationsOutbox(): { operation: string; payload: Record<string, unknown> } {
  const rows = db().executeSync(
    `SELECT * FROM outbox WHERE table_name = 'locations' ORDER BY created_at, rowid`,
  ).rows as { operation: string; payload: string }[];
  const last = rows[rows.length - 1];
  return { operation: last.operation, payload: JSON.parse(last.payload) as Record<string, unknown> };
}

before(async () => {
  await testDb.initTestDb();
  // initTestDb creates locations/taxonomy_types/inventory_items/stock_by_location/
  // outbox; add the tables retireVehicle/reactivateVehicle also touch:
  // vehicle_checkouts (open-checkout guard, via vehicles.getActiveCheckout)
  // and activity_log (appendLog).
  db().executeSync(`
    CREATE TABLE vehicle_checkouts (
      id TEXT PRIMARY KEY, vehicle_location_id TEXT NOT NULL, user_id TEXT NOT NULL,
      job_id TEXT, checked_out_at TEXT NOT NULL, checked_in_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY, user_id TEXT, team_id TEXT, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT, from_location_id TEXT, to_location_id TEXT,
      quantity REAL, unit TEXT, job_id TEXT, note TEXT, metadata TEXT, device_id TEXT,
      created_at TEXT NOT NULL, synced_at TEXT, latitude REAL, longitude REAL, location_accuracy REAL
    );
  `);
  db().executeSync(`INSERT INTO locations (id, name, type, owner_user_id, active, updated_at)
                  VALUES ('van-1', 'Van 1', 'Vehicle', 'owner-1', 1, '2026-01-01')`);
  db().executeSync(`INSERT INTO locations (id, name, type, owner_user_id, active, updated_at)
                  VALUES ('locker-1', 'Locker 1', 'Locker', 'owner-1', 1, '2026-01-01')`);
  db().executeSync(`INSERT INTO users (id, name, role) VALUES ('owner-1', 'Owner', 'mitigation_technician')`);
  loc = requireCjs('./locations') as typeof import('./locations');
});

test('retireVehicle: happy path flips active to 0 and appends an outbox UPDATE', () => {
  const res = loc.retireVehicle('van-1', 'owner-1');
  assert.deepEqual(res, { ok: true });
  assert.equal(locationRow('van-1').active, 0);

  const { operation, payload } = lastLocationsOutbox();
  assert.equal(operation, 'UPDATE');
  assert.deepEqual({ id: payload.id, active: payload.active }, { id: 'van-1', active: false });
  assert.ok(typeof payload.updated_at === 'string', 'retire carries a fresh updated_at watermark');

  const logRow = db().executeSync(
    `SELECT * FROM activity_log WHERE entity_id = 'van-1' ORDER BY created_at DESC LIMIT 1`,
  ).rows[0] as Record<string, unknown>;
  assert.equal(logRow.action, 'location_archived');
  assert.equal(logRow.user_id, 'owner-1');

  // Reset for later tests.
  db().executeSync(`UPDATE locations SET active = 1 WHERE id = 'van-1'`);
});

test('retireVehicle: refuses while the vehicle has an open checkout session', () => {
  db().executeSync(
    `INSERT INTO vehicle_checkouts (id, vehicle_location_id, user_id, checked_out_at, checked_in_at, created_at, updated_at)
     VALUES ('sess-1', 'van-1', 'owner-1', '2026-07-20T00:00:00.000Z', NULL, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')`,
  );
  const res = loc.retireVehicle('van-1', 'owner-1');
  assert.equal(res.ok, false);
  assert.match((res as { ok: false; reason: string }).reason, /checked out/i);
  assert.equal(locationRow('van-1').active, 1, 'vehicle not retired');

  // Close the session so later tests see no open checkout.
  db().executeSync(`UPDATE vehicle_checkouts SET checked_in_at = '2026-07-20T01:00:00.000Z' WHERE id = 'sess-1'`);
});

test('retireVehicle: refuses while the vehicle still holds stock', () => {
  db().executeSync(`INSERT INTO inventory_items (id, name, active) VALUES ('item-1', 'Air Mover', 1)`);
  db().executeSync(
    `INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at) VALUES ('item-1', 'van-1', 2, '2026-07-20T00:00:00.000Z')`,
  );
  const res = loc.retireVehicle('van-1', 'owner-1');
  assert.equal(res.ok, false);
  assert.match((res as { ok: false; reason: string }).reason, /stock/i);
  assert.equal(locationRow('van-1').active, 1, 'vehicle not retired');
});

test('retireVehicle: a qty-0 stock row does not block retiring', () => {
  db().executeSync(`UPDATE stock_by_location SET quantity = 0 WHERE item_id = 'item-1' AND location_id = 'van-1'`);
  const res = loc.retireVehicle('van-1', 'owner-1');
  assert.deepEqual(res, { ok: true });
  assert.equal(locationRow('van-1').active, 0);
});

test('retireVehicle: refuses a non-Vehicle location', () => {
  const res = loc.retireVehicle('locker-1', 'owner-1');
  assert.equal(res.ok, false);
  assert.equal(locationRow('locker-1').active, 1);
});

test('retireVehicle: refuses an unknown id', () => {
  const res = loc.retireVehicle('nope', 'owner-1');
  assert.equal(res.ok, false);
});

test('reactivateVehicle: flips active back to 1 and appends an outbox UPDATE', () => {
  // van-1 was left retired (active=0) by the prior test.
  assert.equal(locationRow('van-1').active, 0);
  const res = loc.reactivateVehicle('van-1', 'owner-1');
  assert.deepEqual(res, { ok: true });
  assert.equal(locationRow('van-1').active, 1);

  const { operation, payload } = lastLocationsOutbox();
  assert.equal(operation, 'UPDATE');
  assert.deepEqual({ id: payload.id, active: payload.active }, { id: 'van-1', active: true });

  const logRow = db().executeSync(
    `SELECT * FROM activity_log WHERE entity_id = 'van-1' AND action = 'location_restored' ORDER BY created_at DESC LIMIT 1`,
  ).rows[0] as Record<string, unknown>;
  assert.ok(logRow, 'reactivate is logged');
});

test('reactivateVehicle: already-active vehicle is a no-op success', () => {
  const before = lastLocationsOutbox();
  const res = loc.reactivateVehicle('van-1', 'owner-1');
  assert.deepEqual(res, { ok: true });
  const after = lastLocationsOutbox();
  assert.deepEqual(after, before, 'no redundant outbox write for an already-active vehicle');
});

test('reactivateVehicle: refuses a non-Vehicle location', () => {
  db().executeSync(`UPDATE locations SET active = 0 WHERE id = 'locker-1'`);
  const res = loc.reactivateVehicle('locker-1', 'owner-1');
  assert.equal(res.ok, false);
  assert.equal(locationRow('locker-1').active, 0);
  db().executeSync(`UPDATE locations SET active = 1 WHERE id = 'locker-1'`);
});

// #153: permission-gating (manage_locations) is a UI concern only — VehiclePanel
// hides the Retire/Reactivate action via usePermission, but the query layer
// itself takes no `permission`/session argument and enforces nothing beyond
// the type + checkout/stock guards above. The outbox write is authorized
// server-side (syncPolicy), same as every other locations UPDATE.
test('retireVehicle/reactivateVehicle take no permission argument — gating is UI-only', () => {
  assert.equal(loc.retireVehicle.length, 2, 'signature is (locationId, userId) — no permission param');
  assert.equal(loc.reactivateVehicle.length, 2, 'signature is (locationId, userId) — no permission param');
});
