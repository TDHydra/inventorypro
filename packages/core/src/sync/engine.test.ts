// The engine's push-verdict handling — previously untestable (the old
// engine.ts imported react-native), now exercised for real under node:test:
// ok → synced, permanent rejection → denied bucket with the friendly message
// + request ref, transient rejection → bounded attempts, afterPush/afterPull
// hooks fire.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initTestDb, configureTestCore, stubFetch } from '../test/helpers';
import type { SqlDb } from '../db/provider';
import { appendOutbox, getPendingOutbox, getDeniedOutbox, getOutboxCounts, getPendingCount } from './outbox';
import { registerAfterPull, registerAfterPush, resetSyncHooksForTest } from './afterPull';
import { syncNow, stopSyncEngine } from './engine';

let db: SqlDb;

before(async () => {
  configureTestCore();
  db = await initTestDb(['app_settings', 'teams', 'outbox']);
});

beforeEach(() => {
  db.executeSync('DELETE FROM outbox');
  db.executeSync('DELETE FROM app_settings');
  resetSyncHooksForTest();
});

// syncNow arms a ~10s fast retry when deliverable work remains — clear it so
// the test process isn't held open.
afterEach(() => stopSyncEngine());

// Routes /sync/push per `verdict` and answers /sync/pull with an empty diff.
function stubPushServer(verdict: (ids: string[]) => { ok: string[]; conflicts: Array<{ id: string; error?: string; code?: string }> }) {
  return stubFetch((url, init) => {
    if (url.includes('/sync/push')) {
      const entries = (JSON.parse(String(init!.body)) as { entries: Array<{ id: string }> }).entries;
      return { body: verdict(entries.map(e => e.id)), headers: { 'x-request-id': 'req-42' } };
    }
    return { body: {} }; // /sync/pull: empty diff
  });
}

test('accepted entries are marked synced', async () => {
  appendOutbox('INSERT', 'teams', { id: 't1', name: 'A' });
  stubPushServer(ids => ({ ok: ids, conflicts: [] }));
  await syncNow();
  assert.equal(getPendingCount(), 0);
});

test('permanent rejection (code FORBIDDEN) → denied bucket, friendly message + ref, no retry', async () => {
  appendOutbox('UPDATE', 'teams', { id: 't1' });
  stubPushServer(ids => ({ ok: [], conflicts: [{ id: ids[0], error: 'Forbidden: teams requires manage_teams', code: 'FORBIDDEN' }] }));
  await syncNow();
  assert.equal(getPendingCount(), 0, 'left the retry loop');
  const [d] = getDeniedOutbox();
  assert.match(d.last_error!, /Your account can't edit teams/);
  assert.match(d.last_error!, /\[ref req-42\]$/);
  assert.doesNotMatch(d.last_error!, /manage_teams/, 'raw permission key withheld from the user');
});

test('transient rejection (code CONFLICT) → attempt counted, entry stays active', async () => {
  appendOutbox('INSERT', 'jobs', { id: 'j1' });
  stubPushServer(ids => ({ ok: [], conflicts: [{ id: ids[0], error: 'FK not yet synced', code: 'CONFLICT' }] }));
  await syncNow();
  const [e] = getPendingOutbox();
  assert.equal(e.attempts, 1);
  assert.match(e.last_error!, /Rejected: FK not yet synced \[ref req-42\]/);
  assert.deepEqual(getOutboxCounts(), { active: 1, failed: 0 });
});

test('HTTP-level push failure increments every entry in the batch', async () => {
  appendOutbox('INSERT', 'teams', { id: 't1' });
  appendOutbox('INSERT', 'teams', { id: 't2' });
  stubFetch(url => url.includes('/sync/push')
    ? { status: 503, body: 'down', headers: { 'x-request-id': 'req-9' } }
    : { body: {} });
  await syncNow();
  for (const e of getPendingOutbox()) {
    assert.equal(e.attempts, 1);
    assert.match(e.last_error!, /HTTP 503/);
    assert.match(e.last_error!, /\[ref req-9\]$/);
  }
});

test('afterPush and afterPull hooks fire in a full cycle', async () => {
  const fired: string[] = [];
  registerAfterPush('reconcile-log', () => fired.push('push'));
  registerAfterPull({ name: 'refresh-caches', run: changed => { fired.push(`pull:${changed.size}`); } });
  appendOutbox('INSERT', 'teams', { id: 't1' });
  stubPushServer(ids => ({ ok: ids, conflicts: [] }));
  await syncNow();
  assert.deepEqual(fired, ['push', 'pull:0']);
});

test('afterPull table filter skips hooks whose tables did not change', async () => {
  const fired: string[] = [];
  registerAfterPull({ name: 'teams-only', tables: ['teams'], run: () => { fired.push('teams'); } });
  registerAfterPull({ name: 'always', run: () => { fired.push('always'); } });
  stubFetch(url => url.includes('/sync/pull')
    ? { body: { teams: { rows: [{ id: 'tX', name: 'B', type: 'field', updated_at: '2026-01-01T00:00:00Z', type_id: null }] } } }
    : { body: { ok: [], conflicts: [] } });
  await syncNow();
  assert.deepEqual(fired, ['teams', 'always']);
});
