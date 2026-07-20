import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// jobAssignments.ts can't load under `node --test` as-is: db/schema imports the
// native op-sqlite binding, utils/uuid imports react-native-get-random-values,
// and log.ts pulls telemetry (expo-constants / react-native). Same harness as
// unitAccess.test.ts: intercept Module._load and swap those for node-safe
// stand-ins — db/schema becomes a REAL sql.js database — so these tests
// exercise the actual helpers end-to-end (transactional writes, outbox rows,
// activity_log entries, and the read-time crew-membership resolution).
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
  if (resolved.endsWith('/src/telemetry/index.ts')) return { track() {} };
  return origLoad.call(this, request, parent, isMain);
};

let ja: typeof import('./jobAssignments');

before(async () => {
  await testDb.initTestDb();
  testDb.getDb().executeSync(`
    CREATE TABLE job_assignments (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
      assignee_kind TEXT NOT NULL, assignee_id TEXT NOT NULL,
      assigned_by TEXT, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      synced_at TEXT, job_number TEXT, customer_name TEXT, site_address TEXT,
      site_location_id TEXT, description TEXT, type TEXT, reference_number TEXT,
      insurance_carrier TEXT, type_id TEXT, team_id TEXT
    );
    CREATE TABLE subteams (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE team_members (
      team_id TEXT NOT NULL, user_id TEXT NOT NULL,
      subteam_id TEXT, subteam_role TEXT, updated_at TEXT,
      PRIMARY KEY (team_id, user_id)
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY, user_id TEXT, team_id TEXT, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT, from_location_id TEXT, to_location_id TEXT,
      quantity REAL, unit TEXT, job_id TEXT, note TEXT, metadata TEXT, device_id TEXT,
      created_at TEXT NOT NULL, synced_at TEXT, latitude REAL, longitude REAL, location_accuracy REAL
    );
  `);
  const db = testDb.getDb();
  db.executeSync(`INSERT INTO users (id, name) VALUES
    ('pm-1', 'Paula PM'), ('lead-1', 'Frank Lead'), ('helper-1', 'Matt Helper'), ('solo-1', 'Sam Solo'), ('outsider-1', 'Olive Out')`);
  db.executeSync(`INSERT INTO teams (id, name) VALUES ('team-1', 'Mitigation')`);
  db.executeSync(`INSERT INTO subteams (id, team_id, name, active, created_at, updated_at) VALUES
    ('crew-1', 'team-1', 'TV/FT', 1, '2026-01-01', '2026-01-01')`);
  // Crew roster lives ON team_members rows: lead + helper both point at crew-1.
  db.executeSync(`INSERT INTO team_members (team_id, user_id, subteam_id, subteam_role) VALUES
    ('team-1', 'lead-1', 'crew-1', 'lead'),
    ('team-1', 'helper-1', 'crew-1', 'helper'),
    ('team-1', 'outsider-1', NULL, NULL)`);
  db.executeSync(`INSERT INTO jobs (id, name, status, created_at, updated_at, job_number) VALUES
    ('job-open', 'Flood on Main St', 'open', '2026-01-02', '2026-01-02', '1001'),
    ('job-open-2', 'Mold remediation', 'open', '2026-01-03', '2026-01-03', '1002'),
    ('job-closed', 'Finished job', 'closed', '2026-01-01', '2026-01-04', '1000')`);
  ja = requireCjs('./jobAssignments') as typeof import('./jobAssignments');
});

test('assignJobToCrew writes the row, an outbox INSERT, and a job_assigned log entry keyed on the job uuid', () => {
  const id = ja.assignJobToCrew('job-open', 'crew-1', 'pm-1');
  const row = testDb.getDb().executeSync(`SELECT * FROM job_assignments WHERE id = ?`, [id]).rows[0] as Record<string, unknown>;
  assert.equal(row.assignee_kind, 'subteam');
  assert.equal(row.assignee_id, 'crew-1');
  assert.equal(row.active, 1);
  assert.equal(row.assigned_by, 'pm-1');
  const ob = testDb.getDb().executeSync(`SELECT payload FROM outbox WHERE table_name='job_assignments' AND operation='INSERT'`).rows;
  assert.equal(ob.length, 1);
  const payload = JSON.parse(String((ob[0] as { payload: string }).payload)) as Record<string, unknown>;
  assert.equal(payload.job_id, 'job-open');
  assert.ok(!('synced_at' in payload), 'local-only column never pushed');
  const log = testDb.getDb().executeSync(`SELECT * FROM activity_log WHERE action='job_assigned'`).rows;
  assert.equal(log.length, 1);
  const entry = log[0] as Record<string, unknown>;
  // activity_log.entity_id is a UUID column server-side — the JOB id goes there,
  // the assignee kind/id ride in metadata (activitylog_uuid trap).
  assert.equal(entry.entity_id, 'job-open');
  assert.equal(entry.entity_type, 'job');
  assert.equal(entry.job_id, 'job-open');
  assert.equal(entry.note, 'TV/FT');
  assert.deepEqual(JSON.parse(String(entry.metadata)), { assignment_id: id, assignee_kind: 'subteam', assignee_id: 'crew-1' });
});

test('re-assigning the same active crew is an idempotent no-op returning the existing id', () => {
  const before1 = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM job_assignments`).rows[0] as { n: number };
  const existing = (testDb.getDb().executeSync(`SELECT id FROM job_assignments WHERE job_id='job-open' AND assignee_id='crew-1' AND active=1`).rows[0] as { id: string }).id;
  const id = ja.assignJobToCrew('job-open', 'crew-1', 'pm-1');
  assert.equal(id, existing);
  const after = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM job_assignments`).rows[0] as { n: number };
  assert.equal(after.n, before1.n, 'no duplicate row');
  const ob = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox WHERE table_name='job_assignments'`).rows[0] as { n: number };
  assert.equal(ob.n, 1, 'no duplicate outbox entry');
});

test('getAssignmentsForJob resolves crew and user names', () => {
  ja.assignJobToUser('job-open', 'solo-1', 'pm-1');
  const rows = ja.getAssignmentsForJob('job-open');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.assignee_name).sort(), ['Sam Solo', 'TV/FT']);
});

test('getAssignableCrews lists active crews with team + lead context', () => {
  const crews = ja.getAssignableCrews();
  assert.equal(crews.length, 1);
  assert.equal(crews[0]!.name, 'TV/FT');
  assert.equal(crews[0]!.team_name, 'Mitigation');
  assert.equal(crews[0]!.lead_name, 'Frank Lead');
});

test('getMyAssignedJobs: crew lead AND helper both resolve the subteam assignment at read time', () => {
  for (const uid of ['lead-1', 'helper-1']) {
    const jobs = ja.getMyAssignedJobs(uid);
    assert.deepEqual(jobs.map(j => j.id), ['job-open'], `${uid} sees the crew's job`);
  }
});

test('getMyAssignedJobs: direct user assignment resolves; non-members see nothing', () => {
  assert.deepEqual(ja.getMyAssignedJobs('solo-1').map(j => j.id), ['job-open']);
  assert.deepEqual(ja.getMyAssignedJobs('outsider-1'), []);
});

test('getMyAssignedJobs excludes closed jobs', () => {
  ja.assignJobToUser('job-closed', 'solo-1', 'pm-1');
  assert.deepEqual(ja.getMyAssignedJobs('solo-1').map(j => j.id), ['job-open'], 'closed job never listed');
});

test('a roster change updates crew members with no assignment rewrite', () => {
  // helper-1 leaves the crew → their "My jobs" empties; a new helper joins → theirs fills.
  testDb.getDb().executeSync(`UPDATE team_members SET subteam_id = NULL, subteam_role = NULL WHERE user_id = 'helper-1'`);
  assert.deepEqual(ja.getMyAssignedJobs('helper-1'), []);
  testDb.getDb().executeSync(`UPDATE team_members SET subteam_id = 'crew-1', subteam_role = 'helper' WHERE user_id = 'outsider-1'`);
  assert.deepEqual(ja.getMyAssignedJobs('outsider-1').map(j => j.id), ['job-open']);
});

test('unassign soft-deletes (active=0), queues the outbox UPDATE, logs job_unassigned, and hides everywhere', () => {
  const crewAssignment = ja.getAssignmentsForJob('job-open').find(a => a.assignee_kind === 'subteam')!;
  ja.unassign(crewAssignment.id, 'pm-1');
  const row = testDb.getDb().executeSync(`SELECT active FROM job_assignments WHERE id = ?`, [crewAssignment.id]).rows[0] as { active: number };
  assert.equal(row.active, 0, 'row stays for history');
  const ob = testDb.getDb().executeSync(`SELECT payload FROM outbox WHERE table_name='job_assignments' AND operation='UPDATE'`).rows;
  assert.equal(ob.length, 1);
  const payload = JSON.parse(String((ob[0] as { payload: string }).payload)) as Record<string, unknown>;
  assert.equal(payload.id, crewAssignment.id);
  assert.equal(payload.active, 0);
  const log = testDb.getDb().executeSync(`SELECT entity_id, note FROM activity_log WHERE action='job_unassigned'`).rows;
  assert.equal(log.length, 1);
  assert.equal((log[0] as { entity_id: string }).entity_id, 'job-open');
  // Inactive assignment excluded from both readers.
  assert.deepEqual(ja.getAssignmentsForJob('job-open').map(a => a.assignee_kind), ['user']);
  assert.deepEqual(ja.getMyAssignedJobs('lead-1'), [], 'inactive assignment never resolves');
});

test('unassign of an already-inactive assignment is a silent no-op; unknown id throws', () => {
  const inactive = testDb.getDb().executeSync(`SELECT id FROM job_assignments WHERE active = 0 LIMIT 1`).rows[0] as { id: string };
  const obBefore = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number }).n;
  ja.unassign(inactive.id, 'pm-1');
  const obAfter = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number }).n;
  assert.equal(obAfter, obBefore, 'no outbox write for a no-op unassign');
  assert.throws(() => ja.unassign('nope', 'pm-1'), /Assignment not found/);
});
