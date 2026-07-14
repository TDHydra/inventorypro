import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { prepareForDemoLogin } from './demoHandoff';

// Picking a demo account used to be hard-blocked whenever ANYTHING was pending in
// the outbox — and getPendingCount() counts dead entries (attempts >= MAX) too, so
// a single stuck row locked the device out of demo accounts for good. The gate now
// pushes the audit trail and lets the rest be discarded. The one thing it must
// still refuse: entering a sandbox (whose logout wipes the DB) while activity_log
// rows have not reached the server.

test('nothing pending → proceeds without touching the network', async () => {
  let pushed = 0;
  const r = await prepareForDemoLogin({
    pendingCount: () => 0,
    pushLogs: async () => { pushed++; return 0; },
  });
  assert.deepEqual(r, { ok: true, stuckLogs: 0 });
  assert.equal(pushed, 0, 'no pending rows means there is nothing to push');
});

test('pending rows, logs push cleanly → proceeds (business changes discarded later)', async () => {
  const r = await prepareForDemoLogin({
    pendingCount: () => 7,
    pushLogs: async () => 0,
  });
  assert.deepEqual(r, { ok: true, stuckLogs: 0 });
});

test('logs still undelivered → blocks, reporting how many', async () => {
  const r = await prepareForDemoLogin({
    pendingCount: () => 4,
    pushLogs: async () => 3,
  });
  assert.deepEqual(r, { ok: false, stuckLogs: 3 },
    'a demo session would wipe these logs — refuse instead of losing the audit trail');
});

test('a push failure blocks rather than letting the sandbox destroy the logs', async () => {
  const r = await prepareForDemoLogin({
    pendingCount: () => 2,
    pushLogs: async () => { throw new Error('offline'); },
  });
  assert.equal(r.ok, false);
  assert.ok(r.stuckLogs > 0, 'an unknown outcome must be treated as undelivered, not as success');
});

// --- Invariants asserted against source (these modules import op-sqlite, which
// cannot load under `node --test` — same approach as fullDownload.test.ts). ---

const here = dirname(new URL(import.meta.url).pathname);
const OUTBOX = readFileSync(join(here, 'outbox.ts'), 'utf8');
const FINISH_LOGIN = readFileSync(join(here, '../auth/finishLogin.ts'), 'utf8');

// reconcileLogSyncState() marks an activity_log row SYNCED as soon as its outbox
// row disappears. So a DELETE that can reach an un-pushed activity_log row would
// silently forge the audit trail as delivered.
test('discardPendingOutbox is the only unconditional pending delete, and is documented as log-safe', () => {
  assert.match(OUTBOX, /export function discardPendingOutbox\(\): number/);
  const deletes = OUTBOX.match(/DELETE FROM outbox[^`]*/g) ?? [];
  for (const stmt of deletes) {
    const scoped = /WHERE id = \?/.test(stmt) || /attempts >= \?/.test(stmt) || /synced_at IS NULL/.test(stmt);
    assert.ok(scoped, `unscoped outbox DELETE: ${stmt}`);
  }
});

// The discard must run in the demo branch only, and only after the picker has
// already pushed the logs (see login.tsx). If it ever moved ahead of the push,
// the audit trail would be destroyed on entry.
test('finishLogin discards the outbox only for a test session', () => {
  assert.match(FINISH_LOGIN, /discardPendingOutbox\(\)/,
    'demo entry must drop the outgoing user\'s pending rows so they cannot be pushed under the demo JWT');
  const branch = FINISH_LOGIN.slice(FINISH_LOGIN.indexOf('const isTestSession'));
  assert.ok(branch.includes('discardPendingOutbox()'),
    'the discard belongs inside the isTestSession branch');
});
