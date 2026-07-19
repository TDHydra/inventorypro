import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Two-tank vehicle state (#122 A2): exercise the REAL vehicles.ts helpers
// against an in-memory sql.js database. vehicles.ts can't load under
// `node --test` as-is: db/schema imports the native op-sqlite binding,
// utils/uuid imports react-native-get-random-values, and log.ts pulls
// telemetry (expo-constants / react-native). Same Module._load intercept as
// locationsShelf.test.ts — db/schema becomes a real sql.js database
// (locationsShelf.testdb.ts) so upsertVehicleState's transactional writes and
// outbox side effects run end-to-end.
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

let veh: typeof import('./vehicles');

before(async () => {
  await testDb.initTestDb();
  testDb.getDb().executeSync(`
    CREATE TABLE vehicles (
      location_id TEXT PRIMARY KEY, truck_mount INTEGER NOT NULL DEFAULT 0,
      water_state TEXT, model TEXT, model_id TEXT, notes TEXT,
      water_tank TEXT NOT NULL DEFAULT 'empty', waste_tank TEXT NOT NULL DEFAULT 'clean',
      updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE vehicle_checkouts (
      id TEXT PRIMARY KEY, vehicle_location_id TEXT NOT NULL, user_id TEXT NOT NULL,
      job_id TEXT, checked_out_at TEXT NOT NULL, checked_in_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY, user_id TEXT, team_id TEXT, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT, from_location_id TEXT, to_location_id TEXT,
      quantity REAL, unit TEXT, job_id TEXT, note TEXT, metadata TEXT, device_id TEXT,
      created_at TEXT NOT NULL, synced_at TEXT, latitude REAL, longitude REAL, location_accuracy REAL
    );
  `);
  veh = requireCjs('./vehicles') as typeof import('./vehicles');
});

test('ensureVehicleRow seeds two-tank defaults', () => {
  veh.ensureVehicleRow('van-1');
  const row = veh.getVehicle('van-1')!;
  assert.equal(row.water_tank, 'empty');
  assert.equal(row.waste_tank, 'clean');
});

test('upsertVehicleState patches one tank without clobbering the other', () => {
  veh.upsertVehicleState('van-1', { water_tank: 'full' }, 'u-matt');
  assert.equal(veh.getVehicle('van-1')!.waste_tank, 'clean');
  veh.upsertVehicleState('van-1', { waste_tank: 'dirty' }, 'u-matt');
  const row = veh.getVehicle('van-1')!;
  assert.equal(row.water_tank, 'full');
  assert.equal(row.waste_tank, 'dirty');
});

test('outbox payload carries both tanks and NO water_state key', () => {
  const rows = testDb.getDb().executeSync(
    `SELECT payload FROM outbox WHERE table_name = 'vehicles' ORDER BY created_at DESC LIMIT 1`).rows;
  const payload = JSON.parse((rows[0] as { payload: string }).payload);
  assert.equal(payload.water_tank, 'full');
  assert.equal(payload.waste_tank, 'dirty');
  assert.ok(!('water_state' in payload), 'legacy column must no longer be pushed');
});

test('getVehicleInlineStatus reads the two tanks', () => {
  const st = veh.getVehicleInlineStatus('van-1');
  assert.equal(st.water_tank, 'full');
  assert.equal(st.waste_tank, 'dirty');
});
