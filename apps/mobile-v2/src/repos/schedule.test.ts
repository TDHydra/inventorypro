import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Same harness as jobs.test.ts/notifications.test.ts/approvals.test.ts —
// schedule.ts can't load under `node --test` as-is (db/schema imports the
// native op-sqlite binding; utils/uuid imports react-native-get-random-values;
// getAssignableManagers pulls in repos/users, which imports auth/session
// (expo-secure-store) for getValidJwt — inert stub, schedule.ts never calls it).
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
  if (resolved.endsWith('/src/auth/session.ts')) return { getValidJwt: async () => null };
  return origLoad.call(this, request, parent, isMain);
};

let sch: typeof import('./schedule');
let log: typeof import('../db/queries/log');
let core: typeof import('@invenpro/core');

const TABLES = ['schedule_assignments', 'jobs', 'users', 'activity_log', 'outbox'];

before(async () => {
  await testDb.initTestDb(TABLES);
  const db = testDb.getDb();
  db.executeSync(`INSERT INTO users (id, name, role, pin_length_required, active, created_at, updated_at) VALUES
    ('emp-1', 'Ellie Employee', 'mitigation_technician', 4, 1, '2026-01-01', '2026-01-01'),
    ('emp-2', 'Ethan Employee', 'contents_crew', 4, 1, '2026-01-01', '2026-01-01'),
    ('pm-1', 'Paula PM', 'production_manager', 6, 1, '2026-01-01', '2026-01-01'),
    ('pm-2', 'Pete PM', 'production_manager', 6, 1, '2026-01-01', '2026-01-01'),
    ('dispatcher-1', 'Dana Dispatcher', 'office_manager', 6, 1, '2026-01-01', '2026-01-01')`);
  db.executeSync(`INSERT INTO jobs (id, name, status, created_at, updated_at, job_number) VALUES
    ('job-1', 'Flood on Main St', 'open', '2026-01-02', '2026-01-02', '1001'),
    ('job-2', 'Mold remediation', 'open', '2026-01-03', '2026-01-03', '1002')`);
  sch = requireCjs('./schedule') as typeof import('./schedule');
  log = requireCjs('../db/queries/log') as typeof import('../db/queries/log');
  core = requireCjs('@invenpro/core') as typeof import('@invenpro/core');
});

function countLog(action: string): number {
  return (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM activity_log WHERE action = ?`, [action]).rows[0] as { n: number }).n;
}

test('assignJobSlot writes the row + an outbox INSERT (no synced_at), self-logs nothing (caller-owned)', () => {
  const before1 = countLog('schedule_assigned');
  const { id, cleared } = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-04', startMinute: 540, endMinute: 600, jobId: 'job-1' }, 'dispatcher-1');
  assert.deepEqual(cleared, []);
  const row = testDb.getDb().executeSync(`SELECT * FROM schedule_assignments WHERE id = ?`, [id]).rows[0] as Record<string, unknown>;
  assert.equal(row.employee_id, 'emp-1');
  assert.equal(row.assignment_kind, 'job');
  assert.equal(row.job_id, 'job-1');
  assert.equal(row.manager_id, null);
  assert.equal(row.active, 1);
  assert.equal(row.created_by, 'dispatcher-1');
  const ob = testDb.getDb().executeSync(`SELECT payload FROM outbox WHERE table_name='schedule_assignments' AND operation='INSERT'`).rows;
  assert.equal(ob.length, 1);
  const payload = JSON.parse(String((ob[0] as { payload: string }).payload)) as Record<string, unknown>;
  assert.equal(payload.job_id, 'job-1');
  assert.ok(!('synced_at' in payload), 'local-only column never pushed');
  assert.equal(countLog('schedule_assigned'), before1, 'repo never appends its own log entry');
});

test('caller wraps runInTransaction + appendLog to record schedule_assigned, keyed on the employee uuid', () => {
  const { runInTransaction } = core;
  let id = '';
  runInTransaction(() => {
    const result = sch.assignJobSlot({ employeeId: 'emp-2', day: '2026-08-04', startMinute: 540, endMinute: 600, jobId: 'job-1' }, 'dispatcher-1');
    id = result.id;
    log.appendLog({
      user_id: 'dispatcher-1', team_id: null, action: 'schedule_assigned', entity_type: 'user',
      entity_id: 'emp-2', from_location_id: null, to_location_id: null, quantity: null, unit: null,
      job_id: 'job-1', note: null,
      metadata: JSON.stringify({ assignment_id: id, day: '2026-08-04', start_minute: 540, end_minute: 600, assignment_kind: 'job', job_id: 'job-1', manager_id: null }),
      device_id: null,
    });
  });
  const entry = testDb.getDb().executeSync(`SELECT * FROM activity_log WHERE action='schedule_assigned' AND entity_id='emp-2'`).rows[0] as Record<string, unknown>;
  assert.equal(entry.job_id, 'job-1');
  assert.deepEqual(JSON.parse(String(entry.metadata)), {
    assignment_id: id, day: '2026-08-04', start_minute: 540, end_minute: 600,
    assignment_kind: 'job', job_id: 'job-1', manager_id: null,
  });
});

test('assignManagerSlot writes a manager-kind row with job_id null', () => {
  const { id } = sch.assignManagerSlot({ employeeId: 'emp-1', day: '2026-08-05', startMinute: 540, endMinute: 600, managerId: 'pm-1' }, 'dispatcher-1');
  const row = testDb.getDb().executeSync(`SELECT * FROM schedule_assignments WHERE id = ?`, [id]).rows[0] as Record<string, unknown>;
  assert.equal(row.assignment_kind, 'manager');
  assert.equal(row.manager_id, 'pm-1');
  assert.equal(row.job_id, null);
});

test('overlapping range throws ScheduleConflictError with the conflicting rows and writes nothing', () => {
  const before1 = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM schedule_assignments`).rows[0] as { n: number }).n;
  assert.throws(
    () => sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-04', startMinute: 570, endMinute: 630, jobId: 'job-2' }, 'dispatcher-1'),
    (err: unknown) => {
      assert.ok(err instanceof sch.ScheduleConflictError);
      assert.equal(err.conflicts.length, 1);
      assert.equal(err.conflicts[0]!.job_id, 'job-1');
      return true;
    },
  );
  const after = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM schedule_assignments`).rows[0] as { n: number }).n;
  assert.equal(after, before1, 'no row written on conflict');
});

test('force:true soft-deletes the prior overlapping slot (outbox UPDATE) and returns it in `cleared`, inserts the new one', () => {
  const { id: newId, cleared } = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-04', startMinute: 570, endMinute: 630, jobId: 'job-2' }, 'dispatcher-1', { force: true });
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.job_id, 'job-1');
  const oldRow = testDb.getDb().executeSync(`SELECT * FROM schedule_assignments WHERE id = ?`, [cleared[0]!.id]).rows[0] as Record<string, unknown>;
  assert.equal(oldRow.active, 0, 'prior slot cleared');
  const clearedOb = testDb.getDb().executeSync(`SELECT payload FROM outbox WHERE table_name='schedule_assignments' AND operation='UPDATE'`).rows;
  assert.equal(clearedOb.length, 1);
  const clearedPayload = JSON.parse(String((clearedOb[0] as { payload: string }).payload)) as Record<string, unknown>;
  assert.equal(clearedPayload.id, oldRow.id);
  assert.equal(clearedPayload.active, false, 'outbox payload keeps the raw JS boolean passed to .update() — only SQL binding normalizes to 0/1');
  assert.equal(countLog('schedule_cleared'), 0, 'repo never appends its own log entry, even for auto-cleared rows');
  const newRow = testDb.getDb().executeSync(`SELECT * FROM schedule_assignments WHERE id = ?`, [newId]).rows[0] as Record<string, unknown>;
  assert.equal(newRow.active, 1);
  assert.equal(newRow.job_id, 'job-2');
});

test('assignJobSlot rejects end_minute <= start_minute', () => {
  assert.throws(() => sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-05', startMinute: 600, endMinute: 600, jobId: 'job-1' }, 'dispatcher-1'), /end_minute must be after start_minute/);
  assert.throws(() => sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-05', startMinute: 600, endMinute: 500, jobId: 'job-1' }, 'dispatcher-1'), /end_minute must be after start_minute/);
});

test('updateSlotTimes moves a slot, guards against overlap, and rejects end<=start', () => {
  const { id } = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-06', startMinute: 480, endMinute: 540, jobId: 'job-1' }, 'dispatcher-1');
  const { row, cleared } = sch.updateSlotTimes(id, 500, 560);
  assert.equal(row.id, id);
  assert.deepEqual(cleared, []);
  const moved = testDb.getDb().executeSync(`SELECT start_minute, end_minute FROM schedule_assignments WHERE id = ?`, [id]).rows[0] as Record<string, number>;
  assert.equal(moved.start_minute, 500);
  assert.equal(moved.end_minute, 560);
  assert.throws(() => sch.updateSlotTimes(id, 600, 600), /end_minute must be after start_minute/);

  const { id: otherId } = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-06', startMinute: 600, endMinute: 660, jobId: 'job-2' }, 'dispatcher-1');
  assert.throws(
    () => sch.updateSlotTimes(id, 610, 670),
    (err: unknown) => err instanceof sch.ScheduleConflictError,
  );
  // force resolves the conflict by clearing the other slot.
  const forced = sch.updateSlotTimes(id, 610, 670, { force: true });
  assert.equal(forced.cleared.length, 1);
  assert.equal(forced.cleared[0]!.id, otherId);
  const otherRow = testDb.getDb().executeSync(`SELECT active FROM schedule_assignments WHERE id = ?`, [otherId]).rows[0] as { active: number };
  assert.equal(otherRow.active, 0);
});

test('updateSlotTimes throws on unknown id and on an already-cleared assignment', () => {
  assert.throws(() => sch.updateSlotTimes('nope', 480, 540), /Assignment not found/);
  const { id } = sch.assignJobSlot({ employeeId: 'emp-2', day: '2026-08-07', startMinute: 480, endMinute: 540, jobId: 'job-1' }, 'dispatcher-1');
  sch.clearSlot(id);
  assert.throws(() => sch.updateSlotTimes(id, 500, 560), /Assignment is cleared/);
});

test('clearSlot soft-deletes (returns the cleared row), no-ops (returns null) on an already-cleared row, and throws on an unknown id', () => {
  const { id } = sch.assignJobSlot({ employeeId: 'emp-2', day: '2026-08-08', startMinute: 480, endMinute: 540, jobId: 'job-1' }, 'dispatcher-1');
  const cleared = sch.clearSlot(id);
  assert.equal(cleared?.id, id);
  const row = testDb.getDb().executeSync(`SELECT active FROM schedule_assignments WHERE id = ?`, [id]).rows[0] as { active: number };
  assert.equal(row.active, 0);
  const obBefore = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number }).n;
  const noop = sch.clearSlot(id); // no-op — already cleared, still "exists"
  assert.equal(noop, null);
  const obAfter = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number }).n;
  assert.equal(obAfter, obBefore, 'no outbox write for a no-op clear');
  assert.throws(() => sch.clearSlot('nope'), /Assignment not found/);
});

test('getScheduleBoardForDay filters by day + active and joins employee/job/manager names', () => {
  const day = '2026-08-09';
  const { id: jobSlot } = sch.assignJobSlot({ employeeId: 'emp-1', day, startMinute: 480, endMinute: 540, jobId: 'job-1' }, 'dispatcher-1');
  sch.assignManagerSlot({ employeeId: 'emp-2', day, startMinute: 600, endMinute: 660, managerId: 'pm-2' }, 'dispatcher-1');
  const { id: clearedId } = sch.assignJobSlot({ employeeId: 'emp-1', day, startMinute: 700, endMinute: 760, jobId: 'job-2' }, 'dispatcher-1');
  sch.clearSlot(clearedId);

  const rows = sch.getScheduleBoardForDay(day);
  assert.equal(rows.length, 2, 'cleared slot excluded');
  const jobRow = rows.find(r => r.id === jobSlot)!;
  assert.equal(jobRow.employee_name, 'Ellie Employee');
  assert.equal(jobRow.job_name, 'Flood on Main St');
  assert.equal(jobRow.job_number, '1001');
  assert.equal(jobRow.manager_name, null);
  const mgrRow = rows.find(r => r.assignment_kind === 'manager')!;
  assert.equal(mgrRow.employee_name, 'Ethan Employee');
  assert.equal(mgrRow.manager_name, 'Pete PM');
  assert.equal(mgrRow.job_name, null);

  // Different day is unaffected.
  assert.deepEqual(sch.getScheduleBoardForDay('2099-01-01'), []);
});

test('getScheduleAssignmentsForJob returns every active row for a multi-slot job across employees/days', () => {
  const { id: id1 } = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-10', startMinute: 480, endMinute: 540, jobId: 'job-2' }, 'dispatcher-1');
  const { id: id2 } = sch.assignJobSlot({ employeeId: 'emp-2', day: '2026-08-10', startMinute: 540, endMinute: 600, jobId: 'job-2' }, 'dispatcher-1');
  const { id: id3 } = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-11', startMinute: 480, endMinute: 540, jobId: 'job-2' }, 'dispatcher-1', { force: true });
  const rows = sch.getScheduleAssignmentsForJob('job-2');
  const ids = rows.map(r => r.id);
  assert.ok(ids.includes(id1) && ids.includes(id2) && ids.includes(id3));
  const scopedToDay = sch.getScheduleAssignmentsForJob('job-2', '2026-08-11');
  assert.deepEqual(scopedToDay.map(r => r.id), [id3]);
});

test('getAssignableManagers returns active production_manager users', () => {
  const names = sch.getAssignableManagers().map(u => u.name).sort();
  assert.deepEqual(names, ['Paula PM', 'Pete PM']);
});

test('getScheduleableEmployees returns only ROLE_TIER-1 users, excluding managers/dispatchers', () => {
  const names = sch.getScheduleableEmployees().map(u => u.name).sort();
  assert.deepEqual(names, ['Ellie Employee', 'Ethan Employee']);
});
