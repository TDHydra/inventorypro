import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Same harness as notifications.test.ts/approvals.test.ts/rooms.test.ts/
// teams.test.ts — jobs.ts can't load under `node --test` as-is (db/schema
// imports the native op-sqlite binding; utils/uuid imports
// react-native-get-random-values; telemetry pulls expo-constants/react-native).
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
  if (resolved.endsWith('/src/location/positionCache.ts')) return { getCachedPosition: () => null };
  return origLoad.call(this, request, parent, isMain);
};

let jobs: typeof import('./jobs');

const TABLES = [
  'jobs', 'job_assignments', 'teams', 'subteams', 'team_members', 'users',
  'activity_log', 'outbox', 'taxonomy_types', 'locations', 'equipment_units',
  'inventory_items',
];

before(async () => {
  await testDb.initTestDb(TABLES);
  const db = testDb.getDb();
  db.executeSync(`INSERT INTO users (id, name, role, pin_length_required, active, created_at, updated_at) VALUES
    ('pm-1', 'Paula PM', 'admin', 4, 1, '2026-01-01', '2026-01-01'),
    ('lead-1', 'Frank Lead', 'field_tech', 4, 1, '2026-01-01', '2026-01-01'),
    ('helper-1', 'Matt Helper', 'field_tech', 4, 1, '2026-01-01', '2026-01-01'),
    ('solo-1', 'Sam Solo', 'field_tech', 4, 1, '2026-01-01', '2026-01-01'),
    ('outsider-1', 'Olive Out', 'field_tech', 4, 1, '2026-01-01', '2026-01-01')`);
  db.executeSync(`INSERT INTO teams (id, name, type, updated_at) VALUES ('team-1', 'Mitigation', 'crew', '2026-01-01')`);
  db.executeSync(`INSERT INTO subteams (id, team_id, name, active, created_at, updated_at) VALUES
    ('crew-1', 'team-1', 'TV/FT', 1, '2026-01-01', '2026-01-01')`);
  db.executeSync(`INSERT INTO team_members (team_id, user_id, subteam_id, subteam_role, joined_at, updated_at) VALUES
    ('team-1', 'lead-1', 'crew-1', 'lead', '2026-01-01', '2026-01-01'),
    ('team-1', 'helper-1', 'crew-1', 'helper', '2026-01-01', '2026-01-01'),
    ('team-1', 'outsider-1', NULL, NULL, '2026-01-01', '2026-01-01')`);
  jobs = requireCjs('./jobs') as typeof import('./jobs');
});

function makeJob(id: string, overrides: Partial<{ name: string; status: string; customer_name: string | null }> = {}) {
  const now = new Date().toISOString();
  return {
    id,
    name: overrides.name ?? `Job ${id}`,
    status: (overrides.status ?? 'open') as 'open' | 'closed' | 'archived',
    created_by: 'pm-1',
    created_at: now,
    updated_at: now,
    synced_at: null,
    customer_name: overrides.customer_name,
  };
}

test('upsertJob inserts the row and omits job_number from the outbox payload', () => {
  jobs.upsertJob(makeJob('job-1', { customer_name: 'Acme Co' }));
  const row = testDb.getDb().executeSync(`SELECT * FROM jobs WHERE id = ?`, ['job-1']).rows[0] as Record<string, unknown>;
  assert.equal(row.name, 'Job job-1');
  assert.equal(row.status, 'open');
  const ob = testDb.getDb().executeSync(
    `SELECT payload FROM outbox WHERE table_name='jobs' AND operation='INSERT' ORDER BY rowid DESC LIMIT 1`,
  ).rows[0] as { payload: string };
  const payload = JSON.parse(ob.payload) as Record<string, unknown>;
  assert.ok(!('job_number' in payload), 'job_number never pushed on create');
  assert.ok(!('synced_at' in payload), 'local-only column never pushed');
});

test('getOpenJobs / searchJobs / getJobById / getAllJobs see the created job', () => {
  assert.ok(jobs.getOpenJobs().some(j => j.id === 'job-1'));
  assert.ok(jobs.searchJobs('job-1').some(j => j.id === 'job-1'));
  assert.equal(jobs.getJobById('job-1')?.name, 'Job job-1');
  assert.ok(jobs.getAllJobs().some(j => j.id === 'job-1'));
});

test('getLatestJobByCustomer and getCustomersWithLatestJobDetails resolve by customer_name', () => {
  const d = jobs.getLatestJobByCustomer('acme co');
  assert.ok(d);
  const all = jobs.getCustomersWithLatestJobDetails();
  assert.ok(all.some(c => c.customer_name === 'Acme Co'));
});

test('updateJobFields patches only the given columns and dual-writes type_id when type changes', () => {
  jobs.updateJobFields('job-1', { description: 'Flood cleanup' });
  const row = testDb.getDb().executeSync(`SELECT description FROM jobs WHERE id='job-1'`).rows[0] as { description: string };
  assert.equal(row.description, 'Flood cleanup');
});

test('archiveJob soft-deletes: status becomes archived, no self-log (caller-owned)', () => {
  jobs.upsertJob(makeJob('job-archive-me'));
  const before1 = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM activity_log`).rows[0] as { n: number }).n;
  jobs.archiveJob('job-archive-me');
  const row = testDb.getDb().executeSync(`SELECT status FROM jobs WHERE id='job-archive-me'`).rows[0] as { status: string };
  assert.equal(row.status, 'archived');
  const after = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM activity_log`).rows[0] as { n: number }).n;
  assert.equal(after, before1, 'archiveJob does not append its own log entry');
});

test('getJobDeployments derives from equipment_units.current_job_id + activity_log checkout_to_job rows', () => {
  jobs.upsertJob(makeJob('job-deploy'));
  testDb.getDb().executeSync(
    `INSERT INTO inventory_items (id, name, unit_category, unit_tracked, unit, category, active, updated_at)
     VALUES ('item-unit', 'Air Mover', 'equipment', 1, 'ea', 'equipment', 1, '2026-01-01'),
            ('item-count', 'Poly Sheeting', 'material', 0, 'roll', 'material', 1, '2026-01-01')`,
  );
  testDb.getDb().executeSync(
    `INSERT INTO equipment_units (id, item_id, asset_tag, status, current_job_id, created_at, updated_at)
     VALUES ('unit-1', 'item-unit', 'AM-001', 'deployed', 'job-deploy', '2026-01-01', '2026-01-01')`,
  );
  testDb.getDb().executeSync(
    `INSERT INTO activity_log (id, action, entity_type, entity_id, job_id, quantity, created_at)
     VALUES ('log-1', 'checkout_to_job', 'item', 'item-count', 'job-deploy', 3, '2026-01-01')`,
  );
  const d = jobs.getJobDeployments('job-deploy');
  assert.equal(d.units.length, 1);
  assert.equal(d.units[0].asset_tag, 'AM-001');
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].item_name, 'Poly Sheeting');
});

test('assignJobToCrew writes the row, an outbox INSERT, and a job_assigned log entry keyed on the job id', () => {
  jobs.upsertJob(makeJob('job-assign'));
  const id = jobs.assignJobToCrew('job-assign', 'crew-1', 'pm-1');
  const row = testDb.getDb().executeSync(`SELECT * FROM job_assignments WHERE id = ?`, [id]).rows[0] as Record<string, unknown>;
  assert.equal(row.assignee_kind, 'subteam');
  assert.equal(row.assignee_id, 'crew-1');
  assert.equal(row.active, 1);
  const ob = testDb.getDb().executeSync(`SELECT payload FROM outbox WHERE table_name='job_assignments' AND operation='INSERT'`).rows;
  assert.equal(ob.length, 1);
  const log = testDb.getDb().executeSync(`SELECT * FROM activity_log WHERE action='job_assigned'`).rows;
  assert.equal(log.length, 1);
  const entry = log[0] as Record<string, unknown>;
  assert.equal(entry.entity_id, 'job-assign');
  assert.equal(entry.entity_type, 'job');
  assert.equal(entry.note, 'TV/FT');
  assert.deepEqual(JSON.parse(String(entry.metadata)), { assignment_id: id, assignee_kind: 'subteam', assignee_id: 'crew-1' });
});

test('re-assigning the same active crew is an idempotent no-op returning the existing id', () => {
  const existing = (testDb.getDb().executeSync(
    `SELECT id FROM job_assignments WHERE job_id='job-assign' AND assignee_id='crew-1' AND active=1`,
  ).rows[0] as { id: string }).id;
  const before1 = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM job_assignments`).rows[0] as { n: number }).n;
  const id = jobs.assignJobToCrew('job-assign', 'crew-1', 'pm-1');
  assert.equal(id, existing);
  const after = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM job_assignments`).rows[0] as { n: number }).n;
  assert.equal(after, before1, 'no duplicate row');
});

test('getAssignmentsForJob resolves crew and user names; getAssignableCrews lists team + lead context', () => {
  jobs.assignJobToUser('job-assign', 'solo-1', 'pm-1');
  const rows = jobs.getAssignmentsForJob('job-assign');
  assert.deepEqual(rows.map(r => r.assignee_name).sort(), ['Sam Solo', 'TV/FT']);
  const crews = jobs.getAssignableCrews();
  assert.equal(crews.length, 1);
  assert.equal(crews[0]!.team_name, 'Mitigation');
  assert.equal(crews[0]!.lead_name, 'Frank Lead');
});

test('getMyAssignedJobs: crew lead AND helper resolve the subteam assignment at read time; non-members see nothing', () => {
  for (const uid of ['lead-1', 'helper-1']) {
    assert.deepEqual(jobs.getMyAssignedJobs(uid).map(j => j.id), ['job-assign']);
  }
  assert.deepEqual(jobs.getMyAssignedJobs('outsider-1'), []);
});

test('unassign soft-deletes (active=0), queues the outbox UPDATE, logs job_unassigned, and hides everywhere', () => {
  const crewAssignment = jobs.getAssignmentsForJob('job-assign').find(a => a.assignee_kind === 'subteam')!;
  jobs.unassign(crewAssignment.id, 'pm-1');
  const row = testDb.getDb().executeSync(`SELECT active FROM job_assignments WHERE id = ?`, [crewAssignment.id]).rows[0] as { active: number };
  assert.equal(row.active, 0);
  const log = testDb.getDb().executeSync(`SELECT entity_id FROM activity_log WHERE action='job_unassigned'`).rows;
  assert.equal(log.length, 1);
  assert.deepEqual(jobs.getMyAssignedJobs('lead-1'), []);
});

test('unassign of an already-inactive assignment is a silent no-op; unknown id throws', () => {
  const inactive = testDb.getDb().executeSync(`SELECT id FROM job_assignments WHERE active = 0 LIMIT 1`).rows[0] as { id: string };
  const obBefore = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number }).n;
  jobs.unassign(inactive.id, 'pm-1');
  const obAfter = (testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number }).n;
  assert.equal(obAfter, obBefore, 'no outbox write for a no-op unassign');
  assert.throws(() => jobs.unassign('nope', 'pm-1'), /Assignment not found/);
});
