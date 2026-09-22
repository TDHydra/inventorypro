// The write path every domain repo rides: local write + outbox mirror must be
// ONE atomic unit with ONE payload (payload drift between the two was the old
// app's silent state-fork bug class).
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initTestDb, configureTestCore } from '../test/helpers';
import type { SqlDb } from '../db/provider';
import { createRepository } from './createRepository';
import { getPendingOutbox } from '../sync/outbox';

let db: SqlDb;

before(async () => {
  configureTestCore();
  db = await initTestDb(['outbox', 'teams', 'stock_by_location', 'users']);
});

beforeEach(() => {
  db.executeSync('DELETE FROM outbox');
  db.executeSync('DELETE FROM teams');
  db.executeSync('DELETE FROM stock_by_location');
});

test('insert: local row + outbox INSERT share one payload; updated_at auto-touched', () => {
  const teams = createRepository('teams');
  teams.insert({ id: 't1', name: 'Crew A', type: 'field' });

  const local = db.executeSync(`SELECT * FROM teams WHERE id = 't1'`).rows[0];
  assert.equal(local.name, 'Crew A');
  assert.ok(local.updated_at, 'updated_at filled');

  const [entry] = getPendingOutbox();
  assert.equal(entry.operation, 'INSERT');
  assert.equal(entry.table_name, 'teams');
  assert.equal(entry.payload.updated_at, local.updated_at, 'same timestamp both sides');
});

test('update: partial patch updates only its columns and mirrors the same payload', () => {
  const teams = createRepository('teams');
  teams.insert({ id: 't1', name: 'Crew A', type: 'field' });
  db.executeSync('DELETE FROM outbox');

  teams.update({ id: 't1', name: 'Crew B' });
  const local = db.executeSync(`SELECT * FROM teams WHERE id = 't1'`).rows[0];
  assert.equal(local.name, 'Crew B');
  assert.equal(local.type, 'field', 'untouched column preserved');

  const [entry] = getPendingOutbox();
  assert.equal(entry.operation, 'UPDATE');
  assert.deepEqual(Object.keys(entry.payload).sort(), ['id', 'name', 'updated_at']);
});

test('composite conflict target (stock_by_location) keys both update and remove', () => {
  const stock = createRepository('stock_by_location');
  stock.insert({ item_id: 'i1', location_id: 'l1', quantity: 5 });
  stock.update({ item_id: 'i1', location_id: 'l1', quantity: 7 });
  assert.equal(db.executeSync(`SELECT quantity FROM stock_by_location`).rows[0].quantity, 7);

  assert.throws(() => stock.update({ item_id: 'i1', quantity: 9 }), /missing key column 'location_id'/);

  stock.remove({ item_id: 'i1', location_id: 'l1' });
  assert.equal(db.executeSync(`SELECT COUNT(*) AS n FROM stock_by_location`).rows[0].n, 0);
});

test('remove refuses delete-forbidden tables (users)', () => {
  const users = createRepository('users');
  assert.throws(() => users.remove({ id: 'u1' }), /never allowed/);
});

test('device-only tables have no repository', () => {
  assert.throws(() => createRepository('outbox'), /device-only/);
});

test('unknown columns in the payload are dropped from the local write but kept in the outbox payload', () => {
  const teams = createRepository('teams');
  // e.g. a server-side computed field a form carried along
  teams.insert({ id: 't2', name: 'X', type: 'field', not_a_column: 'y' });
  assert.equal(db.executeSync(`SELECT COUNT(*) AS n FROM teams WHERE id = 't2'`).rows[0].n, 1);
  const [entry] = getPendingOutbox();
  assert.equal(entry.payload.not_a_column, 'y', 'server decides what it accepts');
});
