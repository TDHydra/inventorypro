// Outbox query semantics against REAL sql.js SQLite via the provider seam —
// the three-bucket contract (pending / failed / denied) the SyncIndicator and
// the engine both depend on.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initTestDb, configureTestCore } from '../test/helpers';
import type { SqlDb } from '../db/provider';
import {
  appendOutbox, getPendingOutbox, getPendingCount, getOutboxCounts,
  markOutboxSynced, markOutboxDenied, getDeniedOutbox, getDeniedCount,
  incrementOutboxAttempt, retryFailedOutbox, getFailedOutbox,
  discardDeniedEntry, getPendingLogCount, isMediaUploadPending,
  MAX_OUTBOX_ATTEMPTS,
} from './outbox';

let db: SqlDb;

before(async () => {
  configureTestCore();
  db = await initTestDb(['outbox']);
});

beforeEach(() => {
  db.executeSync('DELETE FROM outbox');
});

test('appendOutbox stores payload JSON; getPendingOutbox parses it back, oldest first', () => {
  appendOutbox('INSERT', 'inventory_items', { id: 'i1', name: 'Tape' });
  appendOutbox('UPDATE', 'jobs', { id: 'j1' });
  const pending = getPendingOutbox();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].table_name, 'inventory_items');
  assert.deepEqual(pending[0].payload, { id: 'i1', name: 'Tape' });
  assert.equal(getPendingCount(), 2);
});

test('tableName scoping (activity_log drain) only returns that table', () => {
  appendOutbox('INSERT', 'activity_log', { id: 'l1' });
  appendOutbox('INSERT', 'jobs', { id: 'j1' });
  assert.equal(getPendingOutbox(50, 'activity_log').length, 1);
  assert.equal(getPendingLogCount(), 1);
});

test('markOutboxSynced removes entries from pending', () => {
  appendOutbox('INSERT', 'jobs', { id: 'j1' });
  const [e] = getPendingOutbox();
  markOutboxSynced([e.id]);
  assert.equal(getPendingCount(), 0);
});

test('denied entries leave every active bucket but appear in the denied bucket', () => {
  appendOutbox('UPDATE', 'teams', { id: 't1' });
  const [e] = getPendingOutbox();
  markOutboxDenied(e.id, "Your account can't edit teams — this change wasn't saved. [ref r1]");
  assert.equal(getPendingCount(), 0, 'not pending');
  assert.equal(getOutboxCounts().active, 0);
  assert.equal(getOutboxCounts().failed, 0);
  assert.equal(getDeniedCount(), 1);
  const [d] = getDeniedOutbox();
  assert.match(d.last_error!, /can't edit teams/);
  discardDeniedEntry(d.id);
  assert.equal(getDeniedCount(), 0);
});

test('attempts >= MAX move an entry from active to failed; retryFailedOutbox re-arms', () => {
  appendOutbox('INSERT', 'media', { id: 'm1' });
  const [e] = getPendingOutbox();
  for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i++) incrementOutboxAttempt(e.id, 'HTTP 502: bad');
  assert.deepEqual(getOutboxCounts(), { active: 0, failed: 1 });
  assert.equal(getFailedOutbox()[0].id, e.id);
  assert.equal(retryFailedOutbox(), 1);
  assert.deepEqual(getOutboxCounts(), { active: 1, failed: 0 });
});

test('isMediaUploadPending matches the media row id inside the payload only', () => {
  appendOutbox('INSERT', 'media', { id: 'm-123', url: 'x' });
  appendOutbox('INSERT', 'jobs', { id: 'm-999' });
  assert.equal(isMediaUploadPending('m-123'), true);
  assert.equal(isMediaUploadPending('m-999'), false, 'foreign table cannot collide');
  assert.equal(isMediaUploadPending('m-000'), false);
});
