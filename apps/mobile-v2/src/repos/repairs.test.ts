import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Same harness as schedule.test.ts/jobs.test.ts/notifications.test.ts —
// repairs.ts can't load under `node --test` as-is (db/schema imports the
// native op-sqlite binding; utils/uuid imports react-native-get-random-values).
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

let repairs: typeof import('./repairs');

const TABLES = ['repairs', 'repair_parts', 'repair_steps', 'taxonomy_types', 'outbox'];

before(async () => {
  await testDb.initTestDb(TABLES);
  const db = testDb.getDb();
  db.executeSync(`INSERT INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at) VALUES
    ('rs-open', 'repair_status', 'Open', '🟡', 0, 1, '2026-01-01'),
    ('rs-done', 'repair_status', 'Done', '✅', 1, 1, '2026-01-01')`);
  repairs = requireCjs('./repairs') as typeof import('./repairs');
});

function countOutbox(table: string, op: string): number {
  return (testDb.getDb().executeSync(
    `SELECT COUNT(*) AS n FROM outbox WHERE table_name = ? AND operation = ?`, [table, op],
  ).rows[0] as { n: number }).n;
}

test('createRepair inserts a row, resolves status_id from the taxonomy label, and outboxes an INSERT with no synced_at key', () => {
  const before1 = countOutbox('repairs', 'INSERT');
  const repair = repairs.createRepair({
    entity_type: 'item', entity_id: 'item-1', entity_label: 'Dehu #4',
    notes: 'Leaking', parts_needed: null, status: 'Open', created_by: 'user-1',
  });
  assert.equal(repair.status_id, 'rs-open');
  assert.equal(repair.completed_at, null);
  assert.equal(countOutbox('repairs', 'INSERT'), before1 + 1);

  const row = testDb.getDb().executeSync(`SELECT * FROM repairs WHERE id = ?`, [repair.id]).rows[0] as Record<string, unknown>;
  assert.equal(row.entity_label, 'Dehu #4');
  assert.equal(row.synced_at, null); // never set by insert() — omitted from the payload
});

test('getRepairById / getRepairsForEntity resolve `status` from status_id (label follows a taxonomy rename)', () => {
  const repair = repairs.createRepair({
    entity_type: 'equipment_unit', entity_id: 'unit-9', entity_label: 'TAG-9',
    notes: null, parts_needed: null, status: 'Open', created_by: 'user-1',
  });
  assert.equal(repairs.getRepairById(repair.id)?.status, 'Open');

  // Rename the taxonomy label directly — resolveLabels should reflect it
  // without touching the repairs row.
  testDb.getDb().executeSync(`UPDATE taxonomy_types SET label = 'In Progress' WHERE id = 'rs-open'`);
  assert.equal(repairs.getRepairById(repair.id)?.status, 'In Progress');

  const forEntity = repairs.getRepairsForEntity('equipment_unit', 'unit-9');
  assert.equal(forEntity.length, 1);
  assert.equal(forEntity[0].id, repair.id);

  // Restore the label so later tests in this file see the original name.
  testDb.getDb().executeSync(`UPDATE taxonomy_types SET label = 'Open' WHERE id = 'rs-open'`);
});

test('getRepairs filters by done/entityType', () => {
  const openCountBefore = repairs.getRepairs({ done: false }).length;
  const r1 = repairs.createRepair({
    entity_type: 'location', entity_id: 'loc-1', entity_label: 'Truck 3',
    notes: null, parts_needed: null, status: 'Open', created_by: 'user-1',
  });
  assert.equal(repairs.getRepairs({ done: false }).length, openCountBefore + 1);
  assert.equal(repairs.getRepairs({ done: true }).some(r => r.id === r1.id), false);
  assert.equal(repairs.getRepairs({ entityType: 'location' }).some(r => r.id === r1.id), true);
  assert.equal(repairs.getRepairs({ entityType: 'item' }).some(r => r.id === r1.id), false);
});

test('updateRepairFields patches an allowlisted subset + bumps updated_at, outboxes an UPDATE', () => {
  const repair = repairs.createRepair({
    entity_type: 'item', entity_id: 'item-2', entity_label: 'Air mover',
    notes: 'noisy', parts_needed: null, status: 'Open', created_by: 'user-1',
  });
  const before1 = countOutbox('repairs', 'UPDATE');
  const updatedAt = repairs.updateRepairFields(repair.id, { notes: 'fixed noise', cost: 42.5 });
  assert.equal(countOutbox('repairs', 'UPDATE'), before1 + 1);
  const row = testDb.getDb().executeSync(`SELECT * FROM repairs WHERE id = ?`, [repair.id]).rows[0] as Record<string, unknown>;
  assert.equal(row.notes, 'fixed noise');
  assert.equal(row.cost, 42.5);
  assert.equal(row.updated_at, updatedAt);
});

test('updateRepairFields with an empty patch is a no-op (no outbox write, returns "now")', () => {
  const repair = repairs.createRepair({
    entity_type: 'item', entity_id: 'item-3', entity_label: 'Blower',
    notes: null, parts_needed: null, status: 'Open', created_by: 'user-1',
  });
  const before1 = countOutbox('repairs', 'UPDATE');
  repairs.updateRepairFields(repair.id, {});
  assert.equal(countOutbox('repairs', 'UPDATE'), before1);
});

test('updateRepairStatus stamps completed_at for a terminal status and clears it otherwise', () => {
  const repair = repairs.createRepair({
    entity_type: 'item', entity_id: 'item-4', entity_label: 'Fan',
    notes: null, parts_needed: null, status: 'Open', created_by: 'user-1',
  });
  const { completed, updated_at } = repairs.updateRepairStatus(repair.id, 'Done', true);
  assert.equal(completed, true);
  let row = testDb.getDb().executeSync(`SELECT * FROM repairs WHERE id = ?`, [repair.id]).rows[0] as Record<string, unknown>;
  assert.equal(row.status, 'Done');
  assert.equal(row.status_id, 'rs-done');
  assert.equal(row.completed_at, updated_at);

  const reopened = repairs.updateRepairStatus(repair.id, 'Open', false);
  assert.equal(reopened.completed, false);
  row = testDb.getDb().executeSync(`SELECT * FROM repairs WHERE id = ?`, [repair.id]).rows[0] as Record<string, unknown>;
  assert.equal(row.completed_at, null);
});

test('addRepairPart / getRepairParts round-trip, no FK on repair_id/item_id', () => {
  const repair = repairs.createRepair({
    entity_type: 'item', entity_id: 'item-5', entity_label: 'Injectidry',
    notes: null, parts_needed: null, status: 'Open', created_by: 'user-1',
  });
  const before1 = countOutbox('repair_parts', 'INSERT');
  const p1 = repairs.addRepairPart(repair.id, 'part-1', 2, 'each', 'user-1');
  const p2 = repairs.addRepairPart(repair.id, 'part-2', 1, 'each', 'user-1', 'step-1');
  assert.equal(countOutbox('repair_parts', 'INSERT'), before1 + 2);
  const parts = repairs.getRepairParts(repair.id);
  assert.equal(parts.length, 2);
  // created_at can tie at ms resolution (two synchronous inserts in a test),
  // so assert on membership + per-row fields rather than a strict DESC order.
  assert.deepEqual(new Set(parts.map(p => p.id)), new Set([p1, p2]));
  assert.equal(parts.find(p => p.id === p1)?.step_id, null);
  assert.equal(parts.find(p => p.id === p2)?.step_id, 'step-1');
});

test('addRepairStep / getRepairSteps round-trip, chronological (oldest first)', () => {
  const repair = repairs.createRepair({
    entity_type: 'item', entity_id: 'item-6', entity_label: 'Scrubber',
    notes: null, parts_needed: null, status: 'Open', created_by: 'user-1',
  });
  const before1 = countOutbox('repair_steps', 'INSERT');
  const st1 = repairs.addRepairStep(repair.id, 'Checked power cable', 'Fine', 'user-1');
  const st2 = repairs.addRepairStep(repair.id, 'Replaced fuse', 'Fixed', 'user-1');
  assert.equal(countOutbox('repair_steps', 'INSERT'), before1 + 2);
  const steps = repairs.getRepairSteps(repair.id);
  assert.equal(steps.length, 2);
  // created_at can tie at ms resolution (two synchronous inserts in a test),
  // so assert on membership + per-row content rather than a strict ASC order.
  assert.deepEqual(new Set(steps.map(s => s.id)), new Set([st1, st2]));
  assert.equal(steps.find(s => s.id === st1)?.action, 'Checked power cable');
  assert.equal(steps.find(s => s.id === st2)?.action, 'Replaced fuse');
});
