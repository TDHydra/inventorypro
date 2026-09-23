import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Same harness as jobs.test.ts/schedule.test.ts — oncall.ts can't load under
// `node --test` as-is (db/schema imports the native op-sqlite binding;
// utils/uuid imports react-native-get-random-values).
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

let oncall: typeof import('./oncall');
let log: typeof import('../db/queries/log');
let core: typeof import('@invenpro/core');
let rotationIndexForWeek: typeof import('../components/oncall/weekMath').rotationIndexForWeek;

const CREW_A = 'crew-a';
const CREW_B = 'crew-b';
const FRANK = 'user-frank';
const CORA = 'user-cora';

// Saturday 2026-07-18 noon -> Thursday-boundary week '2026-07-16'; the 9-week
// fill window is 2026-07-16 .. 2026-09-10 (matches the old app's test fixture).
const TODAY = '2026-07-18';
const WEEK0 = '2026-07-16';
const WEEK8 = '2026-09-10';

const TABLES = [
  'on_call_shifts', 'on_call_coverage', 'subteams', 'teams', 'users',
  'app_config', 'activity_log', 'outbox',
];

function exec(sql: string, params?: unknown[]) {
  return testDb.getDb().executeSync(sql, params);
}

interface OutboxRow { operation: string; table_name: string; payload: Record<string, unknown> }
function outboxEntries(): OutboxRow[] {
  const rows = exec(`SELECT operation, table_name, payload FROM outbox ORDER BY rowid ASC`).rows as
    Array<{ operation: string; table_name: string; payload: string }>;
  return rows.map(r => ({ operation: r.operation, table_name: r.table_name, payload: JSON.parse(r.payload) }));
}
function clearOutbox(): void { exec(`DELETE FROM outbox`); }
function clearShifts(): void { exec(`DELETE FROM on_call_shifts`); }
function countLog(action: string): number {
  return (exec(`SELECT COUNT(*) AS n FROM activity_log WHERE action = ?`, [action]).rows[0] as { n: number }).n;
}
function setConfig(key: string, value: string): void {
  exec(`INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)`, [key, value, '2026-07-18T00:00:00.000Z']);
}

before(async () => {
  await testDb.initTestDb(TABLES);
  exec(`INSERT INTO teams (id, name, type, updated_at) VALUES ('team-1', 'Mitigation', 'crew', '2026-01-01')`);
  exec(
    `INSERT INTO subteams (id, team_id, name, active, created_at, updated_at) VALUES
      (?, 'team-1', 'Crew A', 1, '2026-01-01', '2026-01-01'),
      (?, 'team-1', 'Crew B', 1, '2026-01-01', '2026-01-01')`,
    [CREW_A, CREW_B],
  );
  exec(
    `INSERT INTO users (id, name, role, pin_length_required, active, created_at, updated_at) VALUES
      (?, 'Frank', 'mitigation_technician', 4, 1, '2026-01-01', '2026-01-01'),
      (?, 'Cora', 'mitigation_technician', 4, 1, '2026-01-01', '2026-01-01')`,
    [FRANK, CORA],
  );
  oncall = requireCjs('./oncall') as typeof import('./oncall');
  log = requireCjs('../db/queries/log') as typeof import('../db/queries/log');
  core = requireCjs('@invenpro/core') as typeof import('@invenpro/core');
  ({ rotationIndexForWeek } = requireCjs('../components/oncall/weekMath') as typeof import('../components/oncall/weekMath'));
});

test('ensureRotationFill fills the 9 boundary weeks per the rotation, idempotently, with outbox INSERTs and no activity log', () => {
  setConfig('on_call_week_boundary', '{"day":4,"hour":8}');
  setConfig('on_call_rotation', JSON.stringify([CREW_A, CREW_B]));
  clearOutbox();

  const inserted = oncall.ensureRotationFill(TODAY, 12, 'u1');
  assert.equal(inserted, oncall.ROTATION_FILL_WEEKS);
  assert.equal(oncall.ROTATION_FILL_WEEKS, 9);

  const shifts = oncall.getShifts(WEEK0, WEEK8);
  assert.equal(shifts.length, 9);
  assert.equal(shifts[0]!.week_start, WEEK0);
  for (const s of shifts) {
    assert.equal(new Date(`${s.week_start}T00:00:00Z`).getUTCDay(), 4, `week ${s.week_start} must be a Thursday`);
    assert.equal(s.subteam_id, [CREW_A, CREW_B][rotationIndexForWeek(s.week_start, 2)]);
    assert.equal(s.subteam_name, s.subteam_id === CREW_A ? 'Crew A' : 'Crew B');
    assert.equal(s.team_id, 'team-1');
  }

  const ops = outboxEntries().filter(o => o.table_name === 'on_call_shifts');
  assert.equal(ops.length, 9);
  assert.ok(ops.every(o => o.operation === 'INSERT'));
  assert.equal(countLog('on_call_assigned'), 0, 'autofill is mechanical — never logged, same as the old app');

  // Second call: everything already assigned -> inserts nothing, one transaction either way.
  clearOutbox();
  assert.equal(oncall.ensureRotationFill(TODAY, 12, 'u1'), 0);
  assert.equal(outboxEntries().length, 0);
});

test('a manual assignWeek override is sticky and never shifts the other weeks; repo itself does not log', () => {
  clearShifts();
  clearOutbox();
  const overrideWeek = '2026-08-06';
  const rotationCrew = [CREW_A, CREW_B][rotationIndexForWeek(overrideWeek, 2)];
  const overrideCrew = rotationCrew === CREW_A ? CREW_B : CREW_A;
  const before1 = countLog('on_call_assigned');
  const result = oncall.assignWeek(overrideWeek, overrideCrew, 'u1');
  assert.ok(result);
  assert.equal(result!.crewName, overrideCrew === CREW_A ? 'Crew A' : 'Crew B');
  assert.equal(result!.teamId, 'team-1');
  assert.equal(countLog('on_call_assigned'), before1, 'repo never appends its own log entry');

  assert.equal(oncall.ensureRotationFill(TODAY, 12, 'u1'), 8); // 9 weeks minus the override

  const shifts = oncall.getShifts(WEEK0, WEEK8);
  assert.equal(shifts.length, 9);
  for (const s of shifts) {
    if (s.week_start === overrideWeek) {
      assert.equal(s.subteam_id, overrideCrew, 'the manual override must survive the fill');
    } else {
      assert.equal(s.subteam_id, [CREW_A, CREW_B][rotationIndexForWeek(s.week_start, 2)]);
    }
  }
});

test('assignWeek(null) clears a week: returns the prior team for the log, no-ops (returns null) when already unassigned', () => {
  clearShifts();
  const week = '2026-09-03';
  oncall.assignWeek(week, CREW_A, 'u1');
  const cleared = oncall.assignWeek(week, null, 'u1');
  assert.deepEqual(cleared, { id: null, teamId: 'team-1', crewName: null });
  assert.equal(oncall.getShifts(week, week).length, 0);

  const noop = oncall.assignWeek(week, null, 'u1');
  assert.equal(noop, null, 'clearing an already-unassigned week is a no-op');
});

test('caller wraps runInTransaction + appendLog to record on_call_assigned', () => {
  const { runInTransaction } = core;
  const week = '2026-09-10';
  let logged: Record<string, unknown> = {};
  runInTransaction(() => {
    const result = oncall.assignWeek(week, CREW_B, 'u1')!;
    log.appendLog({
      user_id: 'u1', team_id: result.teamId, action: 'on_call_assigned', entity_type: 'team',
      entity_id: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
      job_id: null, note: `${result.crewName} on-call for week of ${week}`,
      metadata: JSON.stringify({ shift_id: result.id, week_start: week, subteam_id: CREW_B }),
      device_id: null,
    });
  });
  const entry = exec(`SELECT * FROM activity_log WHERE action='on_call_assigned' ORDER BY rowid DESC LIMIT 1`).rows[0] as Record<string, unknown>;
  logged = entry;
  assert.match(String(logged.note), /Crew B/);
  assert.equal(JSON.parse(String(logged.metadata)).week_start, week);
});

test('empty or absent on_call_rotation -> fill is a no-op', () => {
  clearShifts();
  clearOutbox();
  setConfig('on_call_rotation', '[]');
  assert.equal(oncall.ensureRotationFill(TODAY, 12, 'u1'), 0);
  exec(`DELETE FROM app_config WHERE key = 'on_call_rotation'`);
  assert.equal(oncall.ensureRotationFill(TODAY, 12, 'u1'), 0);
  assert.equal(oncall.getShifts('2000-01-01', '2100-01-01').length, 0);
  assert.equal(outboxEntries().length, 0);
});

test('getCurrentShift: on the boundary day, the hour decides the week', () => {
  clearShifts();
  setConfig('on_call_week_boundary', '{"day":4,"hour":8}');
  exec(
    `INSERT INTO on_call_shifts (id, subteam_id, week_start, created_by, created_at, updated_at, synced_at)
     VALUES ('s-prev', ?, '2026-07-09', 'u1', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', NULL),
            ('s-cur',  ?, '2026-07-16', 'u1', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', NULL)`,
    [CREW_A, CREW_B],
  );
  assert.equal(oncall.getCurrentShift('2026-07-16', 7)?.week_start, '2026-07-09');
  assert.equal(oncall.getCurrentShift('2026-07-16', 9)?.week_start, '2026-07-16');
});

test('getAssignableCrews lists active crews alphabetically with team name', () => {
  const crews = oncall.getAssignableCrews();
  assert.deepEqual(crews.map(c => c.name), ['Crew A', 'Crew B']);
  assert.ok(crews.every(c => c.team_name === 'Mitigation'));
});

test('createCoverage writes the row + an outbox INSERT, self-logs nothing (caller-owned); getCoverage/getCoverageById overlap-match', () => {
  clearOutbox();
  const before1 = countLog('on_call_coverage_added');
  const { id, userOffName, coveringUserName } = oncall.createCoverage({
    dateStart: '2026-07-20', dateEnd: '2026-07-24',
    userOff: FRANK, coveringUser: CORA, note: 'PTO', createdBy: 'u1',
  });
  assert.equal(userOffName, 'Frank');
  assert.equal(coveringUserName, 'Cora');
  assert.equal(countLog('on_call_coverage_added'), before1, 'repo never appends its own log entry');

  const rows = oncall.getCoverage('2026-07-22', '2026-07-30');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, id);
  assert.equal(rows[0]!.user_off_name, 'Frank');
  assert.equal(rows[0]!.covering_user_name, 'Cora');
  assert.equal(oncall.getCoverage('2026-08-01', '2026-08-05').length, 0, 'fully outside the coverage window');

  const byId = oncall.getCoverageById(id);
  assert.equal(byId?.date_start, '2026-07-20');
  assert.equal(oncall.getCoverageById('nope'), null);

  const ops = outboxEntries();
  const cov = ops.find(o => o.table_name === 'on_call_coverage');
  assert.ok(cov, 'coverage row must queue a sync op');
  assert.equal(cov!.operation, 'INSERT');
  assert.equal(cov!.payload.id, id);
  assert.equal(cov!.payload.user_off, FRANK);
  assert.equal(cov!.payload.covering_user, CORA);
});

test('caller wraps runInTransaction + appendLog to record on_call_coverage_added (entity_id null — UUID column server-side)', () => {
  const { runInTransaction } = core;
  let id = '';
  runInTransaction(() => {
    const result = oncall.createCoverage({
      dateStart: '2026-08-01', dateEnd: '2026-08-03', userOff: FRANK, coveringUser: CORA, note: null, createdBy: 'u1',
    });
    id = result.id;
    log.appendLog({
      user_id: 'u1', team_id: null, action: 'on_call_coverage_added', entity_type: 'team', entity_id: null,
      from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
      note: `${result.coveringUserName} covering for ${result.userOffName}`,
      metadata: JSON.stringify({ coverage_id: id, user_off: FRANK, covering_user: CORA }),
      device_id: null,
    });
  });
  const entry = exec(`SELECT * FROM activity_log WHERE action='on_call_coverage_added' ORDER BY rowid DESC LIMIT 1`).rows[0] as Record<string, unknown>;
  assert.equal(entry.entity_id, null, 'UUID-column trap: entity_id stays null, names ride in note/metadata');
  assert.match(String(entry.note), /Cora/);
  assert.match(String(entry.note), /Frank/);
  assert.equal(JSON.parse(String(entry.metadata)).coverage_id, id);
});

test('updateCoverage patches the row (no activity log — no allowlisted action for edits) and still queues an outbox UPDATE', () => {
  const { id } = oncall.createCoverage({
    dateStart: '2026-09-01', dateEnd: '2026-09-02', userOff: FRANK, coveringUser: CORA, note: 'orig', createdBy: 'u1',
  });
  clearOutbox();
  const before1 = (exec(`SELECT COUNT(*) AS n FROM activity_log`).rows[0] as { n: number }).n;
  oncall.updateCoverage({ id, dateStart: '2026-09-01', dateEnd: '2026-09-05', userOff: FRANK, coveringUser: CORA, note: 'extended' });
  const row = oncall.getCoverageById(id);
  assert.equal(row?.date_end, '2026-09-05');
  assert.equal(row?.note, 'extended');
  const after = (exec(`SELECT COUNT(*) AS n FROM activity_log`).rows[0] as { n: number }).n;
  assert.equal(after, before1, 'no allowlisted server action exists for coverage edits — deliberately not logged');
  const ops = outboxEntries().filter(o => o.table_name === 'on_call_coverage' && o.operation === 'UPDATE');
  assert.equal(ops.length, 1, 'the row itself still syncs');
});

test('deleteCoverage removes the row (no activity log) and queues an outbox DELETE', () => {
  const { id } = oncall.createCoverage({
    dateStart: '2026-09-10', dateEnd: '2026-09-11', userOff: FRANK, coveringUser: CORA, note: null, createdBy: 'u1',
  });
  clearOutbox();
  const before1 = (exec(`SELECT COUNT(*) AS n FROM activity_log`).rows[0] as { n: number }).n;
  oncall.deleteCoverage(id);
  assert.equal(oncall.getCoverageById(id), null);
  const after = (exec(`SELECT COUNT(*) AS n FROM activity_log`).rows[0] as { n: number }).n;
  assert.equal(after, before1);
  const ops = outboxEntries().filter(o => o.table_name === 'on_call_coverage' && o.operation === 'DELETE');
  assert.equal(ops.length, 1);
});
