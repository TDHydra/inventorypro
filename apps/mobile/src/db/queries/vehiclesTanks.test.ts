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
    CREATE TABLE vehicle_service_records (
      id TEXT PRIMARY KEY, vehicle_location_id TEXT NOT NULL, target TEXT NOT NULL,
      event_date TEXT NOT NULL, type TEXT NOT NULL, notes TEXT, odometer REAL,
      cost REAL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      synced_at TEXT
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

test('ensureVehicleRow honors truck_mount init (#122 follow-up: set at creation)', () => {
  veh.ensureVehicleRow('van-tm', { truck_mount: 1 });
  assert.equal(veh.getVehicle('van-tm')!.truck_mount, 1);
  const rows = testDb.getDb().executeSync(
    `SELECT payload FROM outbox WHERE table_name = 'vehicles' ORDER BY created_at DESC LIMIT 1`).rows;
  const payload = JSON.parse((rows[0] as { payload: string }).payload);
  assert.equal(payload.truck_mount, 1, 'outbox payload must carry the initial truck_mount');
  // Idempotent: a second ensure with a different value must NOT overwrite.
  veh.ensureVehicleRow('van-tm', { truck_mount: 0 });
  assert.equal(veh.getVehicle('van-tm')!.truck_mount, 1);
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

test('#144: getActiveCheckoutForUser finds my open session with the vehicle name', () => {
  const db = testDb.getDb();
  db.executeSync(`INSERT INTO locations (id, name, type, updated_at) VALUES ('van-qa', 'Van QA', 'Vehicle', '2026-01-01')`);
  db.executeSync(`INSERT INTO users (id, name) VALUES ('u-driver', 'Driver Dan')`);
  // No session yet → null.
  assert.equal(veh.getActiveCheckoutForUser('u-driver'), null);
  const sessionId = veh.checkOutVehicle('van-qa', null, 'u-driver');
  const mine = veh.getActiveCheckoutForUser('u-driver')!;
  assert.equal(mine.vehicle_location_id, 'van-qa');
  assert.equal(mine.vehicle_name, 'Van QA');
  // Someone else's lookup stays empty; check-in clears mine.
  assert.equal(veh.getActiveCheckoutForUser('u-matt'), null);
  veh.checkInVehicle(sessionId, 'u-driver');
  assert.equal(veh.getActiveCheckoutForUser('u-driver'), null);
});

test('#141: takeover logs prior driver + checkout timestamp in the note', () => {
  const db = testDb.getDb();
  db.executeSync(`INSERT INTO locations (id, name, type, updated_at) VALUES ('van-to', 'Van TO', 'Vehicle', '2026-01-01')`);
  db.executeSync(`INSERT INTO users (id, name) VALUES ('u-frank', 'Frank')`);
  db.executeSync(`INSERT INTO users (id, name) VALUES ('u-taker', 'Taker Tom')`);
  veh.checkOutVehicle('van-to', null, 'u-frank');
  const holderOutAt = veh.getActiveCheckout('van-to')!.checked_out_at;
  veh.takeOverVehicle('van-to', null, 'u-taker');
  // Frank's session is closed, Tom holds the new one.
  const active = veh.getActiveCheckout('van-to')!;
  assert.equal(active.user_id, 'u-taker');
  // The takeover activity row names the prior driver AND their checkout time.
  const note = (testDb.getDb().executeSync(
    `SELECT note FROM activity_log WHERE action = 'vehicle_checkout' AND user_id = 'u-taker' ORDER BY created_at DESC LIMIT 1`,
  ).rows[0] as { note: string }).note;
  assert.match(note, /took over from Frank/);
  assert.ok(note.includes(holderOutAt), 'note must carry the prior checkout timestamp');
});

test('#141: odometer timeline returns only rows with readings, newest first', () => {
  const db = testDb.getDb();
  db.executeSync(`INSERT INTO locations (id, name, type, updated_at) VALUES ('van-odo', 'Van Odo', 'Vehicle', '2026-01-01')`);
  const mk = (date: string, odo: number | null, type = 'Oil change') =>
    veh.createServiceRecord({
      vehicleLocationId: 'van-odo', target: 'vehicle', eventDate: date,
      type, notes: null, odometer: odo, cost: null, userId: 'u-matt',
    });
  mk('2026-05-01', 84000);
  mk('2026-06-01', null);      // no reading — excluded
  mk('2026-07-01', 84500);
  const timeline = veh.getOdometerTimeline('van-odo');
  assert.deepEqual(timeline.map(r => r.odometer), [84500, 84000]);
});

test('#141: getFuelUps filters to fuel_up records only', () => {
  veh.createServiceRecord({
    vehicleLocationId: 'van-odo', target: 'vehicle', eventDate: '2026-07-10',
    type: 'fuel_up', notes: '12.5 gal', odometer: null, cost: 55, userId: 'u-matt',
  });
  const fuels = veh.getFuelUps('van-odo');
  assert.equal(fuels.length, 1);
  assert.equal(fuels[0].type, 'fuel_up');
  assert.equal(fuels[0].notes, '12.5 gal');
});
