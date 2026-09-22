// runInTransaction against REAL sql.js SQLite via the provider seam (no
// Module._load intercepts needed anymore — that was the point of the seam).
// Covers the local-write → version bump wiring: bumps deferred to COMMIT,
// deduped per transaction, discarded on ROLLBACK, immediate outside a
// transaction, reentrant joins.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initTestDb, configureTestCore } from '../test/helpers';
import type { SqlDb } from './provider';
import { runInTransaction, queueTableBump } from './tx';
import { subscribeTables } from '../sync/dataVersion';

let db: SqlDb;
let bumps: string[] = [];
const unsubs: Array<() => void> = [];

before(async () => {
  configureTestCore();
  db = await initTestDb(['outbox']);
});

beforeEach(() => {
  bumps = [];
  while (unsubs.length) unsubs.pop()!();
  db.executeSync('DELETE FROM outbox');
});

function watch(table: string): void {
  unsubs.push(subscribeTables([table], () => bumps.push(table)));
}

test('outside a transaction: bump fires immediately', () => {
  watch('inventory_items');
  queueTableBump('inventory_items');
  assert.deepEqual(bumps, ['inventory_items']);
});

test('inside a transaction: bump deferred to COMMIT, deduped', () => {
  watch('jobs');
  runInTransaction(() => {
    queueTableBump('jobs');
    queueTableBump('jobs');
    assert.deepEqual(bumps, [], 'no bump before COMMIT');
  });
  assert.deepEqual(bumps, ['jobs'], 'exactly one bump after COMMIT');
});

test('ROLLBACK discards bumps and re-throws the original error; writes undone', () => {
  watch('teams');
  assert.throws(
    () => runInTransaction(() => {
      db.executeSync(
        `INSERT INTO outbox (id, operation, table_name, payload, created_at, attempts, denied)
         VALUES ('x', 'INSERT', 'teams', '{}', 't', 0, 0)`);
      queueTableBump('teams');
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(bumps, []);
  assert.equal(db.executeSync('SELECT COUNT(*) AS n FROM outbox').rows[0].n, 0, 'insert rolled back');
});

test('reentrant: nested call joins the outer transaction; single commit + bump set', () => {
  watch('a'); watch('b');
  runInTransaction(() => {
    queueTableBump('a');
    runInTransaction(() => queueTableBump('b'));
    assert.deepEqual(bumps, [], 'inner return does not commit');
  });
  assert.deepEqual([...bumps].sort(), ['a', 'b']);
});

test('transaction return value passes through', () => {
  assert.equal(runInTransaction(() => 42), 42);
});
