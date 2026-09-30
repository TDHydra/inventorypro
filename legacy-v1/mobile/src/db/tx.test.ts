import { createRequire } from 'node:module';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// tx.ts + outbox.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding. Reuse the Module._load redirect established by
// locationsShelf.test.ts / suggestions.test.ts: db/schema becomes the REAL
// sql.js database (locationsShelf.testdb.ts), so runInTransaction issues actual
// BEGIN/COMMIT/ROLLBACK against actual SQLite. Covers the local-write → version
// bump wiring: bumps deferred to COMMIT, deduped per transaction, discarded on
// ROLLBACK, immediate outside a transaction.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./queries/locationsShelf.testdb') as typeof import('./queries/locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  return origLoad.call(this, request, parent, isMain);
};

let tx: typeof import('./tx');
let dataVersion: typeof import('../sync/dataVersion');
let outbox: typeof import('../sync/outbox');

// Per-test listener bookkeeping: subscribeTables returns an unsubscribe fn; each
// test subscribes fresh and unsubscribes itself, so counts never bleed across tests.
let fires: string[];

before(async () => {
  await testDb.initTestDb();
  tx = requireCjs('./tx') as typeof import('./tx');
  dataVersion = requireCjs('../sync/dataVersion') as typeof import('../sync/dataVersion');
  outbox = requireCjs('../sync/outbox') as typeof import('../sync/outbox');
});

beforeEach(() => { fires = []; });

function listen(tables: string[], tag: string): () => void {
  return dataVersion.subscribeTables(tables, () => { fires.push(tag); });
}

test('queueTableBump outside a transaction fires immediately', () => {
  const off = listen(['vehicles'], 'v');
  const before = dataVersion.getTablesVersion(['vehicles']);
  tx.queueTableBump('vehicles');
  assert.deepEqual(fires, ['v']);
  assert.equal(dataVersion.getTablesVersion(['vehicles']), before + 1);
  off();
});

test('bumps inside a transaction are deferred to COMMIT and deduped', () => {
  const off = listen(['vehicles', 'locations'], 'any');
  const beforeV = dataVersion.getTablesVersion(['vehicles']);
  const beforeL = dataVersion.getTablesVersion(['locations']);
  let firesDuringTx = -1;
  tx.runInTransaction(() => {
    tx.queueTableBump('vehicles');
    tx.queueTableBump('vehicles'); // dup — must collapse
    tx.queueTableBump('locations');
    firesDuringTx = fires.length;
  });
  assert.equal(firesDuringTx, 0, 'listeners must not fire before COMMIT');
  // One deduped notify for the whole transaction, both table counters advanced once.
  assert.deepEqual(fires, ['any']);
  assert.equal(dataVersion.getTablesVersion(['vehicles']), beforeV + 1);
  assert.equal(dataVersion.getTablesVersion(['locations']), beforeL + 1);
  off();
});

test('ROLLBACK discards queued bumps', () => {
  const off = listen(['vehicles'], 'v');
  const before = dataVersion.getTablesVersion(['vehicles']);
  assert.throws(() => {
    tx.runInTransaction(() => {
      tx.queueTableBump('vehicles');
      throw new Error('boom');
    });
  }, /boom/);
  assert.deepEqual(fires, []);
  assert.equal(dataVersion.getTablesVersion(['vehicles']), before);
  // The failed transaction must not leave deferral state behind: a bump outside
  // any transaction still fires immediately.
  tx.queueTableBump('vehicles');
  assert.deepEqual(fires, ['v']);
  off();
});

test('nested runInTransaction joins the outer commit — single bump at the end', () => {
  const off = listen(['vehicles', 'locations'], 'any');
  tx.runInTransaction(() => {
    tx.queueTableBump('vehicles');
    tx.runInTransaction(() => {
      tx.queueTableBump('locations');
    });
    assert.equal(fires.length, 0, 'inner "commit" must not fire — outer frame owns it');
  });
  assert.deepEqual(fires, ['any']);
  off();
});

test('appendOutbox inside a transaction writes the row and bumps its table after COMMIT', () => {
  const off = listen(['vehicles'], 'v');
  const before = dataVersion.getTablesVersion(['vehicles']);
  tx.runInTransaction(() => {
    outbox.appendOutbox('INSERT', 'vehicles', { location_id: 'veh-1', truck_mount: 1 });
    assert.equal(fires.length, 0);
  });
  assert.deepEqual(fires, ['v']);
  assert.equal(dataVersion.getTablesVersion(['vehicles']), before + 1);
  const rows = testDb.getDb().executeSync(
    `SELECT table_name, operation FROM outbox WHERE table_name = 'vehicles' AND synced_at IS NULL`
  ).rows as { table_name: string; operation: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation, 'INSERT');
  off();
});
