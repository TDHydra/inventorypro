import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Vehicle checkout lock queries (#165): exercise isCheckoutLockedFor against
// an in-memory sql.js database. vehicles.ts can't load under `node --test`
// as-is: db/schema imports the native op-sqlite binding, utils/uuid imports
// react-native-get-random-values, and log.ts pulls telemetry (expo-constants /
// react-native). Same Module._load intercept as vehiclesTanks.test.ts —
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

let veh: typeof import('./vehicles');

before(async () => {
  await testDb.initTestDb(); // creates locations/taxonomy_types/outbox
  testDb.getDb().executeSync(`
    CREATE TABLE vehicles (
      location_id TEXT PRIMARY KEY, truck_mount INTEGER NOT NULL DEFAULT 0,
      water_state TEXT, model TEXT, model_id TEXT, notes TEXT,
      water_tank TEXT NOT NULL DEFAULT 'empty', waste_tank TEXT NOT NULL DEFAULT 'clean',
      checkout_locked INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT);
    CREATE TABLE team_members (
      team_id TEXT NOT NULL, user_id TEXT NOT NULL,
      is_manager INTEGER NOT NULL DEFAULT 0, subteam_id TEXT, subteam_role TEXT,
      PRIMARY KEY (team_id, user_id)
    );
  `);
  const db = testDb.getDb();
  // Vehicle 'van-1' owned by tech-owner, locked.
  db.executeSync(`INSERT INTO locations (id, name, type, owner_user_id, active, updated_at)
                  VALUES ('van-1', 'Van 1', 'Vehicle', 'tech-owner', 1, '2026-01-01')`);
  db.executeSync(`INSERT INTO vehicles (location_id, checkout_locked, updated_at)
                  VALUES ('van-1', 1, '2026-01-01')`);
  db.executeSync(`INSERT INTO users (id, name, role) VALUES
                  ('tech-owner','Owner','mitigation_technician'),
                  ('pm-team','PM','production_manager'),
                  ('pm-other','PM2','production_manager'),
                  ('om-1','Office','office_manager'),
                  ('crew-team','Crew','mitigation_technician')`);
  db.executeSync(`INSERT INTO team_members (team_id, user_id) VALUES
                  ('team-a','tech-owner'), ('team-a','pm-team'), ('team-a','crew-team'),
                  ('team-b','pm-other')`);
  veh = requireCjs('./vehicles') as typeof import('./vehicles');
});

test('locked vehicle: owner and tier-3 bypass (existing behavior)', () => {
  assert.equal(veh.isCheckoutLockedFor('van-1', 'tech-owner'), false);
  assert.equal(veh.isCheckoutLockedFor('van-1', 'om-1'), false);
});

test('locked vehicle: tier-2 PM sharing the owner team bypasses (#165)', () => {
  assert.equal(veh.isCheckoutLockedFor('van-1', 'pm-team'), false);
});

test('locked vehicle: other-team PM and same-team crew stay locked', () => {
  assert.equal(veh.isCheckoutLockedFor('van-1', 'pm-other'), true);
  assert.equal(veh.isCheckoutLockedFor('van-1', 'crew-team'), true);
  assert.equal(veh.isCheckoutLockedFor('van-1', null), true);
});

test('unlocked vehicle: never locked for anyone', () => {
  testDb.getDb().executeSync(`UPDATE vehicles SET checkout_locked = 0 WHERE location_id = 'van-1'`);
  assert.equal(veh.isCheckoutLockedFor('van-1', 'crew-team'), false);
  testDb.getDb().executeSync(`UPDATE vehicles SET checkout_locked = 1 WHERE location_id = 'van-1'`);
});
