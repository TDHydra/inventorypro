import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// access.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding, utils/uuid imports react-native-get-random-values,
// and log.ts pulls telemetry (expo-constants / react-native). Same harness as
// locationsShelf.test.ts / unitAccess.test.ts: intercept Module._load (tsx runs
// this package's TS as CommonJS, so ESM loader hooks would not see the
// transitive requires) and swap those for node-safe stand-ins — db/schema
// becomes a REAL sql.js database (locationsShelf.testdb.ts) — so these tests
// exercise getAccessibleSourceLocations end-to-end against real tables.
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

let access: typeof import('./access');

before(async () => {
  await testDb.initTestDb();
  // initTestDb creates locations/taxonomy_types/outbox; add the access tables.
  testDb.getDb().executeSync(`
    CREATE TABLE unit_access (
      location_id TEXT NOT NULL, user_id TEXT NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 1, can_add INTEGER NOT NULL DEFAULT 0,
      can_remove INTEGER NOT NULL DEFAULT 0, can_move INTEGER NOT NULL DEFAULT 0,
      can_edit_details INTEGER NOT NULL DEFAULT 0, can_grant INTEGER NOT NULL DEFAULT 0,
      granted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT,
      PRIMARY KEY (location_id, user_id)
    );
    CREATE TABLE locker_access (
      location_id TEXT NOT NULL, user_id TEXT NOT NULL, granted_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT,
      PRIMARY KEY (location_id, user_id)
    );
    CREATE TABLE team_members (
      team_id TEXT NOT NULL, user_id TEXT NOT NULL,
      is_manager INTEGER NOT NULL DEFAULT 0,
      subteam_id TEXT, subteam_role TEXT,
      PRIMARY KEY (team_id, user_id)
    );
  `);
  // All units ownerless so the ONLY route to access is an explicit grant —
  // isolates the grants source from the owned/teammate paths.
  testDb.getDb().executeSync(`
    INSERT INTO locations (id, name, type, owner_user_id, active, updated_at) VALUES
      ('lock-g',   'Granted Locker', 'Locker',  NULL, 1, '2026-07-19T00:00:00.000Z'),
      ('lock-nv',  'No-view Locker', 'Locker',  NULL, 1, '2026-07-19T00:00:00.000Z'),
      ('lock-old', 'Legacy Locker',  'Locker',  NULL, 1, '2026-07-19T00:00:00.000Z'),
      ('veh-g',    'Granted Van',    'Vehicle', NULL, 1, '2026-07-19T00:00:00.000Z');
    INSERT INTO unit_access (location_id, user_id, can_view, created_at, updated_at) VALUES
      ('lock-g',  'user-a', 1, '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z'),
      ('lock-nv', 'user-a', 0, '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z'),
      ('veh-g',   'user-a', 1, '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z');
    INSERT INTO locker_access (location_id, user_id, granted_by, created_at, updated_at) VALUES
      ('lock-old', 'user-a', 'owner-1', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z');
  `);
  access = requireCjs('./access') as typeof import('./access');
});

test('day-to-day grants come from unit_access can_view=1, partitioned by type', () => {
  const acc = access.getAccessibleSourceLocations('user-a');
  assert.deepEqual(acc.lockers.map(l => l.id), ['lock-g']);
  assert.deepEqual(acc.vehicles.map(v => v.id), ['veh-g']);
});

test('a can_view=0 grant and a legacy locker_access-only row do not grant access', () => {
  const acc = access.getAccessibleSourceLocations('user-a');
  const ids = [...acc.lockers, ...acc.vehicles].map(l => l.id);
  assert.ok(!ids.includes('lock-nv'), 'can_view=0 must not grant day-to-day access');
  assert.ok(!ids.includes('lock-old'), 'deprecated locker_access must no longer be read');
});
