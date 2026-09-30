import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// rooms.ts can't load under `node --test` as-is: db/schema imports the native
// op-sqlite binding and utils/uuid imports react-native-get-random-values.
// Same harness as jobAssignments.test.ts: intercept Module._load and swap
// db/schema for a REAL sql.js database so these tests exercise the actual
// helpers end-to-end (writes, dedup/reactivate, outbox rows).
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./locationsShelf.testdb') as typeof import('./locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  if (request === 'react-native' || request === 'expo' || request === 'expo-modules-core') {
    return new Proxy({ __esModule: true }, { get: (_t, p) => (p === '__esModule' ? true : () => {}) });
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  return origLoad.call(this, request, parent, isMain);
};

let rooms: typeof import('./rooms');

before(async () => {
  await testDb.initTestDb();
  testDb.getDb().executeSync(`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT
    );
  `);
  rooms = requireCjs('./rooms') as typeof import('./rooms');
});

test('addRoom inserts a new row, active, plus an outbox INSERT', () => {
  const id = rooms.addRoom('Kitchen');
  const row = testDb.getDb().executeSync(`SELECT * FROM rooms WHERE id = ?`, [id]).rows[0] as Record<string, unknown>;
  assert.equal(row.name, 'Kitchen');
  assert.equal(row.active, 1);
  const ob = testDb.getDb().executeSync(`SELECT payload FROM outbox WHERE table_name='rooms' AND operation='INSERT'`).rows;
  assert.equal(ob.length, 1);
  const payload = JSON.parse(String((ob[0] as { payload: string }).payload)) as Record<string, unknown>;
  assert.equal(payload.name, 'Kitchen');
  assert.equal(payload.active, true);
});

test('addRoom trims whitespace', () => {
  const id = rooms.addRoom('  Garage  ');
  const row = testDb.getDb().executeSync(`SELECT name FROM rooms WHERE id = ?`, [id]).rows[0] as { name: string };
  assert.equal(row.name, 'Garage');
});

test('addRoom is case-insensitively idempotent — returns the existing id, no duplicate row/outbox', () => {
  const before1 = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM rooms`).rows[0] as { n: number };
  const existing = (testDb.getDb().executeSync(`SELECT id FROM rooms WHERE name = 'Kitchen'`).rows[0] as { id: string }).id;
  const id = rooms.addRoom('kitchen');
  assert.equal(id, existing);
  const after = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM rooms`).rows[0] as { n: number };
  assert.equal(after.n, before1.n, 'no duplicate row');
  const ob = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox WHERE table_name='rooms'`).rows[0] as { n: number };
  assert.equal(ob.n, 2, 'no duplicate outbox entry for the idempotent re-add');
});

test('addRoom reactivates an inactive duplicate instead of inserting a second row', () => {
  const id = rooms.addRoom('Basement');
  testDb.getDb().executeSync(`UPDATE rooms SET active = 0 WHERE id = ?`, [id]);
  assert.deepEqual(rooms.getRooms().map(r => r.name), ['Garage', 'Kitchen']);
  const reactivatedId = rooms.addRoom('Basement');
  assert.equal(reactivatedId, id);
  const row = testDb.getDb().executeSync(`SELECT active FROM rooms WHERE id = ?`, [id]).rows[0] as { active: number };
  assert.equal(row.active, 1);
  const count = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM rooms WHERE LOWER(name) = 'basement'`).rows[0] as { n: number };
  assert.equal(count.n, 1, 'no duplicate row from the reactivate path');
});

test('getRooms defaults to active-only, sorted case-insensitively by name', () => {
  const names = rooms.getRooms().map(r => r.name);
  assert.deepEqual(names, ['Basement', 'Garage', 'Kitchen']);
});

test('getRooms({ includeInactive: true }) includes inactive rows', () => {
  const id = rooms.addRoom('Attic');
  testDb.getDb().executeSync(`UPDATE rooms SET active = 0 WHERE id = ?`, [id]);
  const active = rooms.getRooms().map(r => r.name);
  assert.ok(!active.includes('Attic'));
  const all = rooms.getRooms({ includeInactive: true }).map(r => r.name);
  assert.ok(all.includes('Attic'));
});
