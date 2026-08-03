import { createRequire } from 'node:module';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// #212 close-out guard: counts that block a careless job close. Same
// Module._load intercept + sql.js testdb pattern as outbox.test.ts.
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
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  return origLoad.call(this, request, parent, isMain);
};

let units: typeof import('./equipmentUnits');

before(async () => {
  await testDb.initTestDb();
  // The shared testdb doesn't carry these two tables — create just the columns
  // the blocker counts touch.
  testDb.getDb().executeSync(`
    CREATE TABLE IF NOT EXISTS equipment_units (
      id TEXT PRIMARY KEY, item_id TEXT, asset_tag TEXT, status TEXT,
      current_location_id TEXT, current_job_id TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS repairs (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      status TEXT, completed_at TEXT, updated_at TEXT
    );
  `);
  units = requireCjs('./equipmentUnits') as typeof import('./equipmentUnits');
});

beforeEach(() => {
  testDb.getDb().executeSync(`DELETE FROM equipment_units`);
  testDb.getDb().executeSync(`DELETE FROM repairs`);
});

function seedUnit(id: string, jobId: string | null) {
  testDb.getDb().executeSync(
    `INSERT INTO equipment_units (id, item_id, asset_tag, status, current_job_id, updated_at)
     VALUES (?, 'item-1', ?, 'deployed', ?, '2026-08-02T00:00:00Z')`,
    [id, `TAG-${id}`, jobId]
  );
}

function seedRepair(id: string, unitId: string, completedAt: string | null) {
  testDb.getDb().executeSync(
    `INSERT INTO repairs (id, entity_type, entity_id, status, completed_at, updated_at)
     VALUES (?, 'equipment_unit', ?, 'Open', ?, '2026-08-02T00:00:00Z')`,
    [id, unitId, completedAt]
  );
}

test('empty selection has no blockers', () => {
  assert.deepEqual(units.getCloseoutBlockers([]), { deployedUnits: 0, openRepairs: 0 });
});

test('counts only units still deployed to the selected jobs', () => {
  seedUnit('u1', 'job-a');
  seedUnit('u2', 'job-a');
  seedUnit('u3', 'job-b');   // other job
  seedUnit('u4', null);      // in the shop
  assert.deepEqual(units.getCloseoutBlockers(['job-a']), { deployedUnits: 2, openRepairs: 0 });
});

test('counts open repairs on those deployed units, ignoring completed ones and other jobs', () => {
  seedUnit('u1', 'job-a');
  seedUnit('u2', 'job-b');
  seedRepair('r1', 'u1', null);                     // open, on job-a's unit → counted
  seedRepair('r2', 'u1', '2026-08-01T00:00:00Z');   // completed → ignored
  seedRepair('r3', 'u2', null);                     // open but unit on other job → ignored
  assert.deepEqual(units.getCloseoutBlockers(['job-a']), { deployedUnits: 1, openRepairs: 1 });
});

test('a bulk selection aggregates across all selected jobs', () => {
  seedUnit('u1', 'job-a');
  seedUnit('u2', 'job-b');
  seedRepair('r1', 'u2', null);
  assert.deepEqual(units.getCloseoutBlockers(['job-a', 'job-b']), { deployedUnits: 2, openRepairs: 1 });
});

test('describeCloseoutBlockers renders counts with correct plurals, omitting zero buckets', () => {
  assert.equal(
    units.describeCloseoutBlockers({ deployedUnits: 3, openRepairs: 1 }),
    '3 units still checked out · 1 open repair'
  );
  assert.equal(units.describeCloseoutBlockers({ deployedUnits: 1, openRepairs: 0 }), '1 unit still checked out');
  assert.equal(units.describeCloseoutBlockers({ deployedUnits: 0, openRepairs: 2 }), '2 open repairs');
});
