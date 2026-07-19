import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// unitAccess.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding, utils/uuid imports react-native-get-random-values,
// and log.ts pulls telemetry (expo-constants / react-native). Same harness as
// locationsShelf.test.ts: intercept Module._load (tsx runs this package's TS
// as CommonJS, so ESM loader hooks would not see the transitive requires) and
// swap those for node-safe stand-ins — db/schema becomes a REAL sql.js
// database (locationsShelf.testdb.ts) — so these tests exercise the actual
// helpers end-to-end, including the transactional writes and outbox effects.
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

let ua: typeof import('./unitAccess');

before(async () => {
  await testDb.initTestDb();
  testDb.getDb().executeSync(`
    CREATE TABLE unit_access (
      location_id TEXT NOT NULL, user_id TEXT NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 1, can_add INTEGER NOT NULL DEFAULT 0,
      can_remove INTEGER NOT NULL DEFAULT 0, can_move INTEGER NOT NULL DEFAULT 0,
      can_edit_details INTEGER NOT NULL DEFAULT 0, can_grant INTEGER NOT NULL DEFAULT 0,
      granted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT,
      PRIMARY KEY (location_id, user_id)
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY, user_id TEXT, team_id TEXT, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT, from_location_id TEXT, to_location_id TEXT,
      quantity REAL, unit TEXT, job_id TEXT, note TEXT, metadata TEXT, device_id TEXT,
      created_at TEXT NOT NULL, synced_at TEXT, latitude REAL, longitude REAL, location_accuracy REAL
    );
  `);
  testDb.getDb().executeSync(`INSERT INTO users (id, name) VALUES ('user-a', 'Frank'), ('owner-1', 'Matt')`);
  ua = requireCjs('./unitAccess') as typeof import('./unitAccess');
});

test('upsertUnitAccess writes the row, an outbox INSERT, and an activity log entry', () => {
  ua.upsertUnitAccess({ location_id: 'loc-1', user_id: 'user-a', can_view: true, can_add: true, can_remove: false, can_move: false, can_edit_details: false, can_grant: false, granted_by: 'owner-1' });
  const row = testDb.getDb().executeSync(`SELECT * FROM unit_access WHERE location_id='loc-1' AND user_id='user-a'`).rows[0] as Record<string, unknown>;
  assert.equal(row.can_add, 1);
  assert.equal(row.can_remove, 0);
  const ob = testDb.getDb().executeSync(`SELECT * FROM outbox WHERE table_name='unit_access' AND operation='INSERT'`).rows;
  assert.equal(ob.length, 1);
  const payload = JSON.parse(String((ob[0] as { payload: string }).payload)) as Record<string, unknown>;
  assert.equal(payload.can_view, 1); // 0/1, matches server BOOLEAN coercion via toBindable
  assert.ok(!('synced_at' in payload), 'local-only column never pushed');
});

test('getUserUnitPerms maps a row to booleans and defaults to all-false with no row', () => {
  assert.deepEqual(ua.getUserUnitPerms('user-a', 'loc-1'), { view: true, add: true, remove: false, move: false, editDetails: false, grant: false });
  assert.deepEqual(ua.getUserUnitPerms('nobody', 'loc-1'), { view: false, add: false, remove: false, move: false, editDetails: false, grant: false });
});

test('getUnitAccessRows joins user names, name order', () => {
  const rows = ua.getUnitAccessRows('loc-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.user_name, 'Frank');
});

test('revokeUnitAccess deletes the row and queues a composite-key outbox DELETE', () => {
  ua.revokeUnitAccess('loc-1', 'user-a');
  assert.equal((testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM unit_access`).rows[0] as { n: number }).n, 0);
  const del = testDb.getDb().executeSync(`SELECT payload FROM outbox WHERE table_name='unit_access' AND operation='DELETE'`).rows;
  assert.equal(del.length, 1);
  assert.deepEqual(JSON.parse(String((del[0] as { payload: string }).payload)), { location_id: 'loc-1', user_id: 'user-a' });
});
