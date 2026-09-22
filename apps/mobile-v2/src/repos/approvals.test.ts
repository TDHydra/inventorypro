import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// approvals.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding and utils/uuid imports react-native-get-random-values.
// Same harness as rooms.test.ts/teams.test.ts.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./testDb') as typeof import('./testDb');

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

let approvals: typeof import('./approvals');

before(async () => {
  await testDb.initTestDb(['approval_requests', 'outbox']);
  approvals = requireCjs('./approvals') as typeof import('./approvals');
});

test('createApprovalRequest inserts a local `open` row + queues an outbox INSERT', () => {
  const row = approvals.createApprovalRequest({
    requesterId: 'u-1', title: 'Need a new drill', detail: 'Old one broke', entityType: 'item', entityId: 'item-1',
  });
  assert.equal(row.status, 'open');
  assert.equal(row.requester_id, 'u-1');
  assert.equal(row.kind, 'manual');

  const dbRow = testDb.getDb().executeSync(`SELECT * FROM approval_requests WHERE id = ?`, [row.id]).rows[0] as Record<string, unknown>;
  assert.equal(dbRow.status, 'open');
  assert.equal(dbRow.title, 'Need a new drill');

  const ob = testDb.getDb().executeSync(`SELECT payload FROM outbox WHERE table_name='approval_requests' AND operation='INSERT'`).rows[0] as { payload: string };
  const payload = JSON.parse(ob.payload) as Record<string, unknown>;
  assert.equal(payload.id, row.id);
  assert.equal(payload.status, 'open');
});

test('createApprovalRequest defaults kind to "manual" and nullable fields to null', () => {
  const row = approvals.createApprovalRequest({ requesterId: 'u-2', title: 'Plain request' });
  assert.equal(row.kind, 'manual');
  assert.equal(row.detail, null);
  assert.equal(row.entity_type, null);
  assert.equal(row.entity_id, null);
});

test('listOpenApprovals returns only open requests, newest first', () => {
  const rows = approvals.listOpenApprovals();
  assert.ok(rows.length >= 2);
  assert.ok(rows.every(r => r.status === 'open'));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].created_at >= rows[i].created_at);
  }
});

test('decideApproval (approve) stamps status/decided_by/decided_at/decision_note locally + queues an outbox UPDATE', () => {
  const created = approvals.createApprovalRequest({ requesterId: 'u-3', title: 'Approve me' });
  approvals.decideApproval(created.id, 'approved', 'mgr-1', 'Looks good');

  const row = approvals.getApprovalRequestById(created.id);
  assert.ok(row);
  assert.equal(row!.status, 'approved');
  assert.equal(row!.decided_by, 'mgr-1');
  assert.equal(row!.decision_note, 'Looks good');
  assert.ok(row!.decided_at);

  const ob = testDb.getDb().executeSync(
    `SELECT payload FROM outbox WHERE table_name='approval_requests' AND operation='UPDATE' ORDER BY rowid DESC LIMIT 1`,
  ).rows[0] as { payload: string };
  const payload = JSON.parse(ob.payload) as Record<string, unknown>;
  assert.equal(payload.id, created.id);
  assert.equal(payload.status, 'approved');
  assert.equal(payload.decided_by, 'mgr-1');
});

test('decideApproval (reject) with no note stores a null decision_note', () => {
  const created = approvals.createApprovalRequest({ requesterId: 'u-4', title: 'Reject me' });
  approvals.decideApproval(created.id, 'rejected', 'mgr-1');
  const row = approvals.getApprovalRequestById(created.id);
  assert.equal(row!.status, 'rejected');
  assert.equal(row!.decision_note, null);
});

test('a decided request no longer appears in listOpenApprovals', () => {
  const created = approvals.createApprovalRequest({ requesterId: 'u-5', title: 'Will be decided' });
  approvals.decideApproval(created.id, 'approved', 'mgr-1');
  const open = approvals.listOpenApprovals();
  assert.ok(!open.some(r => r.id === created.id));
});

test('getApprovalRequestById returns undefined for an unknown id', () => {
  assert.equal(approvals.getApprovalRequestById('nonexistent'), undefined);
});
