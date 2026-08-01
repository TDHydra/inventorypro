import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// schedule.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding, utils/uuid imports react-native-get-random-values,
// and log.ts pulls telemetry (expo-constants / react-native). Same harness as
// jobAssignments.test.ts: intercept Module._load and swap those for node-safe
// stand-ins — db/schema becomes a REAL sql.js database — so these tests
// exercise the actual helpers end-to-end (transactional writes, outbox rows,
// activity_log entries, and the view joins).
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
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  // getAssignableManagers pulls in queries/users, which imports auth/session
  // (expo-secure-store) for getValidJwt — inert stub, schedule.ts never calls it.
  if (resolved.endsWith('/src/auth/session.ts')) return { getValidJwt: async () => null };
  if (resolved.endsWith('/src/telemetry/index.ts')) return { track() {} };
  return origLoad.call(this, request, parent, isMain);
};

let sch: typeof import('./schedule');

before(async () => {
  await testDb.initTestDb();
  testDb.getDb().executeSync(`
    CREATE TABLE schedule_assignments (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      day TEXT NOT NULL,
      start_minute INTEGER NOT NULL,
      end_minute INTEGER NOT NULL,
      assignment_kind TEXT NOT NULL,
      job_id TEXT,
      manager_id TEXT,
      note TEXT,
      created_by TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      synced_at TEXT, job_number TEXT, customer_name TEXT, site_address TEXT,
      site_location_id TEXT, description TEXT, type TEXT, reference_number TEXT,
      insurance_carrier TEXT, type_id TEXT, team_id TEXT
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY, user_id TEXT, team_id TEXT, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT, from_location_id TEXT, to_location_id TEXT,
      quantity REAL, unit TEXT, job_id TEXT, note TEXT, metadata TEXT, device_id TEXT,
      created_at TEXT NOT NULL, synced_at TEXT, latitude REAL, longitude REAL, location_accuracy REAL
    );
  `);
  const db = testDb.getDb();
  db.executeSync(`INSERT INTO users (id, name, role, active) VALUES
    ('emp-1', 'Ellie Employee', 'construction_crew', 1),
    ('emp-2', 'Ethan Employee', 'construction_crew', 1),
    ('pm-1', 'Paula PM', 'production_manager', 1),
    ('pm-2', 'Pete PM', 'production_manager', 1),
    ('dispatcher-1', 'Dana Dispatcher', 'office_manager', 1)`);
  db.executeSync(`INSERT INTO jobs (id, name, status, created_at, updated_at, job_number) VALUES
    ('job-1', 'Flood on Main St', 'open', '2026-01-02', '2026-01-02', '1001'),
    ('job-2', 'Mold remediation', 'open', '2026-01-03', '2026-01-03', '1002')`);
  sch = requireCjs('./schedule') as typeof import('./schedule');
});

test('assignJobSlot writes the row, an outbox INSERT (no synced_at), and a schedule_assigned log entry keyed on the employee uuid', () => {
  const id = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-04', startMinute: 540, endMinute: 600, jobId: 'job-1' }, 'dispatcher-1');
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
  const log = testDb.getDb().executeSync(`SELECT * FROM activity_log WHERE action='schedule_assigned'`).rows;
  assert.equal(log.length, 1);
  const entry = log[0] as Record<string, unknown>;
  // activity_log.entity_id is a UUID column server-side — the EMPLOYEE id goes
  // there, kind/day/times/job_id ride in metadata (activitylog_uuid trap).
  assert.equal(entry.entity_id, 'emp-1');
  assert.equal(entry.entity_type, 'user');
  assert.equal(entry.job_id, 'job-1');
  assert.deepEqual(JSON.parse(String(entry.metadata)), {
    assignment_id: id, day: '2026-08-04', start_minute: 540, end_minute: 600,
    assignment_kind: 'job', job_id: 'job-1', manager_id: null,
  });
});

test('assignManagerSlot writes a manager-kind row with job_id null', () => {
  const id = sch.assignManagerSlot({ employeeId: 'emp-2', day: '2026-08-04', startMinute: 540, endMinute: 600, managerId: 'pm-1' }, 'dispatcher-1');
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

test('force:true soft-deletes the prior overlapping slot (own outbox UPDATE + schedule_cleared log) and inserts the new one', () => {
  const newId = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-04', startMinute: 570, endMinute: 630, jobId: 'job-2' }, 'dispatcher-1', { force: true });
  const oldRow = testDb.getDb().executeSync(`SELECT * FROM schedule_assignments WHERE job_id = 'job-1' AND employee_id = 'emp-1'`).rows[0] as Record<string, unknown>;
  assert.equal(oldRow.active, 0, 'prior slot cleared');
  const clearedOb = testDb.getDb().executeSync(`SELECT payload FROM outbox WHERE table_name='schedule_assignments' AND operation='UPDATE'`).rows;
  assert.equal(clearedOb.length, 1);
  const clearedPayload = JSON.parse(String((clearedOb[0] as { payload: string }).payload)) as Record<string, unknown>;
  assert.equal(clearedPayload.id, oldRow.id);
  assert.equal(clearedPayload.active, 0);
  const clearedLog = testDb.getDb().executeSync(`SELECT * FROM activity_log WHERE action='schedule_cleared'`).rows;
  assert.equal(clearedLog.length, 1);
  const newRow = testDb.getDb().executeSync(`SELECT * FROM schedule_assignments WHERE id = ?`, [newId]).rows[0] as Record<string, unknown>;
  assert.equal(newRow.active, 1);
  assert.equal(newRow.job_id, 'job-2');
});

test('assignJobSlot rejects end_minute <= start_minute', () => {
  assert.throws(() => sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-05', startMinute: 600, endMinute: 600, jobId: 'job-1' }, 'dispatcher-1'), /end_minute must be after start_minute/);
  assert.throws(() => sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-05', startMinute: 600, endMinute: 500, jobId: 'job-1' }, 'dispatcher-1'), /end_minute must be after start_minute/);
});

test('updateSlotTimes moves a slot, guards against overlap, and rejects end<=start', () => {
  const id = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-06', startMinute: 480, endMinute: 540, jobId: 'job-1' }, 'dispatcher-1');
  sch.updateSlotTimes(id, 500, 560, 'dispatcher-1');
  const row = testDb.getDb().executeSync(`SELECT start_minute, end_minute FROM schedule_assignments WHERE id = ?`, [id]).rows[0] as Record<string, number>;
  assert.equal(row.start_minute, 500);
  assert.equal(row.end_minute, 560);
  assert.throws(() => sch.updateSlotTimes(id, 600, 600, 'dispatcher-1'), /end_minute must be after start_minute/);

  const otherId = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-06', startMinute: 600, endMinute: 660, jobId: 'job-2' }, 'dispatcher-1');
  assert.throws(
    () => sch.updateSlotTimes(id, 610, 670, 'dispatcher-1'),
    (err: unknown) => err instanceof sch.ScheduleConflictError,
  );
  // force resolves the conflict by clearing the other slot.
  sch.updateSlotTimes(id, 610, 670, 'dispatcher-1', { force: true });
  const otherRow = testDb.getDb().executeSync(`SELECT active FROM schedule_assignments WHERE id = ?`, [otherId]).rows[0] as { active: number };
  assert.equal(otherRow.active, 0);
});

test('updateSlotTimes throws on unknown id and on an already-cleared assignment', () => {
  assert.throws(() => sch.updateSlotTimes('nope', 480, 540, 'dispatcher-1'), /Assignment not found/);
  const id = sch.assignJobSlot({ employeeId: 'emp-2', day: '2026-08-07', startMinute: 480, endMinute: 540, jobId: 'job-1' }, 'dispatcher-1');
  sch.clearSlot(id, 'dispatcher-1');
  assert.throws(() => sch.updateSlotTimes(id, 500, 560, 'dispatcher-1'), /Assignment is cleared/);
});

test('clearSlot soft-deletes, no-ops on an already-cleared row, and throws on an unknown id', () => {
  const id = sch.assignJobSlot({ employeeId: 'emp-2', day: '2026-08-08', startMinute: 480, endMinute: 540, jobId: 'job-1' }, 'dispatcher-1');
  sch.clearSlot(id, 'dispatcher-1');
  const row = testDb.getDb().executeSync(`SELECT active FROM schedule_assignments WHERE id = ?`, [id]).rows[0] as { active: number };
  assert.equal(row.active, 0);
  const obBefore = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number }).n;
  sch.clearSlot(id, 'dispatcher-1'); // no-op — already cleared, still "exists"
  const obAfter = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number }).n;
  assert.equal(obAfter, obBefore, 'no outbox write for a no-op clear');
  assert.throws(() => sch.clearSlot('nope', 'dispatcher-1'), /Assignment not found/);
});

test('getScheduleBoardForDay filters by day + active and joins employee/job/manager names', () => {
  const day = '2026-08-09';
  const jobSlot = sch.assignJobSlot({ employeeId: 'emp-1', day, startMinute: 480, endMinute: 540, jobId: 'job-1' }, 'dispatcher-1');
  sch.assignManagerSlot({ employeeId: 'emp-2', day, startMinute: 600, endMinute: 660, managerId: 'pm-2' }, 'dispatcher-1');
  const clearedId = sch.assignJobSlot({ employeeId: 'emp-1', day, startMinute: 700, endMinute: 760, jobId: 'job-2' }, 'dispatcher-1');
  sch.clearSlot(clearedId, 'dispatcher-1');

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
  const id1 = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-10', startMinute: 480, endMinute: 540, jobId: 'job-2' }, 'dispatcher-1');
  const id2 = sch.assignJobSlot({ employeeId: 'emp-2', day: '2026-08-10', startMinute: 540, endMinute: 600, jobId: 'job-2' }, 'dispatcher-1');
  const id3 = sch.assignJobSlot({ employeeId: 'emp-1', day: '2026-08-11', startMinute: 480, endMinute: 540, jobId: 'job-2' }, 'dispatcher-1', { force: true });
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
