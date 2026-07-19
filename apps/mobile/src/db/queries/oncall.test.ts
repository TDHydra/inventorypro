import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { rotationIndexForWeek } from '../../components/oncall/weekMath';

// #122 Phase C — boundary-aware on-call queries: rotation auto-fill, the
// hour-aware current shift, and coverage CRUD. oncall.ts can't load under
// `node --test` as-is (db/schema imports the native op-sqlite binding,
// utils/uuid imports react-native-get-random-values, log.ts pulls telemetry +
// expo-location), so this uses the chat.test.ts / unitAccess.test.ts harness:
// intercept Module._load, swap db/schema for a REAL sql.js database
// (locationsShelf.testdb.ts), and stub the RN-only modules — the actual query
// module then runs end-to-end including its transaction/outbox/log effects.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./locationsShelf.testdb') as typeof import('./locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  // Side-effect-only crypto polyfill; node already has crypto.getRandomValues.
  if (request === 'react-native-get-random-values') return {};
  // The GPS-stamping log path (#33) transitively imports expo-location, which
  // pulls in expo / expo-modules-core / react-native — none of which parse under
  // tsx/esbuild (react-native/index.js is Flow-typed) or run outside Metro. These
  // tests never exercise GPS, so hand back a benign no-op stub for each; every
  // property access returns a no-op fn so any polyfill init on load stays inert.
  if (request === 'react-native' || request === 'expo' || request === 'expo-modules-core') {
    return new Proxy({ __esModule: true }, { get: (_t, p) => (p === '__esModule' ? true : () => {}) });
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  if (resolved.endsWith('/src/telemetry/index.ts')) return { track() {} };
  return origLoad.call(this, request, parent, isMain);
};

let oncall: typeof import('./oncall');

const CREW_A = 'crew-a';
const CREW_B = 'crew-b';
const FRANK = 'user-frank';
const CORA = 'user-cora';

// Saturday 2026-07-18 noon → Thursday-boundary week '2026-07-16'; the 9-week
// fill window is 2026-07-16 … 2026-09-10 (used as the getShifts range below).
const TODAY = '2026-07-18';
const WEEK0 = '2026-07-16';
const WEEK8 = '2026-09-10';

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
function setConfig(key: string, value: string): void {
  exec(`INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)`, [key, value, '2026-07-18T00:00:00.000Z']);
}

before(async () => {
  await testDb.initTestDb(); // locations/taxonomy_types/outbox
  // On-call tables mirror mobile migrations 044 + 048; subteams/teams for the
  // crew joins, users for the coverage name joins, app_config for the boundary
  // + rotation settings, activity_log because createCoverage/assignWeek write
  // through the real appendLog.
  exec(`
    CREATE TABLE on_call_shifts (
      id TEXT PRIMARY KEY, subteam_id TEXT, week_start TEXT NOT NULL UNIQUE,
      created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE on_call_coverage (
      id TEXT PRIMARY KEY, date_start TEXT NOT NULL, date_end TEXT NOT NULL,
      user_off TEXT, covering_user TEXT, note TEXT, created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT
    );
    CREATE TABLE subteams (id TEXT PRIMARY KEY, team_id TEXT, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT, synced_at TEXT);
    CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE activity_log (
      id TEXT PRIMARY KEY, user_id TEXT, team_id TEXT, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT, from_location_id TEXT, to_location_id TEXT,
      quantity REAL, unit TEXT, job_id TEXT, note TEXT, metadata TEXT, device_id TEXT,
      created_at TEXT NOT NULL, synced_at TEXT, latitude REAL, longitude REAL, location_accuracy REAL
    );
  `);
  exec(`INSERT INTO teams (id, name) VALUES ('team-1', 'Mitigation')`);
  exec(`INSERT INTO subteams (id, team_id, name) VALUES (?, 'team-1', 'Crew A'), (?, 'team-1', 'Crew B')`, [CREW_A, CREW_B]);
  exec(`INSERT INTO users (id, name) VALUES (?, 'Frank'), (?, 'Cora')`, [FRANK, CORA]);
  oncall = requireCjs('./oncall') as typeof import('./oncall');
});

test('ensureRotationFill fills the 9 boundary weeks per the rotation, idempotently, with outbox INSERTs', () => {
  setConfig('on_call_week_boundary', '{"day":4,"hour":8}');
  setConfig('on_call_rotation', JSON.stringify([CREW_A, CREW_B]));
  clearOutbox();

  const inserted = oncall.ensureRotationFill(TODAY, 12, 'u1');
  assert.equal(inserted, oncall.ROTATION_FILL_WEEKS);
  assert.equal(oncall.ROTATION_FILL_WEEKS, 9);

  const shifts = oncall.getShifts(WEEK0, WEEK8);
  assert.equal(shifts.length, 9);
  assert.equal(shifts[0].week_start, WEEK0);
  for (const s of shifts) {
    // Thursday-keyed (boundary day 4), never Monday.
    assert.equal(new Date(`${s.week_start}T00:00:00Z`).getUTCDay(), 4, `week ${s.week_start} must be a Thursday`);
    // Crew is the calendar-anchored rotation slot — alternating for length 2.
    assert.equal(s.subteam_id, [CREW_A, CREW_B][rotationIndexForWeek(s.week_start, 2)]);
  }

  const ops = outboxEntries().filter(o => o.table_name === 'on_call_shifts');
  assert.equal(ops.length, 9);
  assert.ok(ops.every(o => o.operation === 'INSERT'));

  // Second call: everything already assigned → inserts nothing.
  clearOutbox();
  assert.equal(oncall.ensureRotationFill(TODAY, 12, 'u1'), 0);
  assert.equal(outboxEntries().length, 0);
});

test('a manual assignWeek override is sticky and never shifts the other weeks', () => {
  clearShifts();
  clearOutbox();
  const overrideWeek = '2026-08-06';
  // Whatever the rotation would place there, assign the OTHER crew manually.
  const rotationCrew = [CREW_A, CREW_B][rotationIndexForWeek(overrideWeek, 2)];
  const overrideCrew = rotationCrew === CREW_A ? CREW_B : CREW_A;
  oncall.assignWeek(overrideWeek, overrideCrew, 'u1');

  assert.equal(oncall.ensureRotationFill(TODAY, 12, 'u1'), 8); // 9 weeks minus the override

  const shifts = oncall.getShifts(WEEK0, WEEK8);
  assert.equal(shifts.length, 9);
  for (const s of shifts) {
    if (s.week_start === overrideWeek) {
      assert.equal(s.subteam_id, overrideCrew, 'the manual override must survive the fill');
    } else {
      // Slots are calendar-anchored, so the override does NOT shift neighbors.
      assert.equal(s.subteam_id, [CREW_A, CREW_B][rotationIndexForWeek(s.week_start, 2)]);
    }
  }
});

test('empty or absent on_call_rotation → fill is a no-op', () => {
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
  // Thursday 07:00 → still last week's shift; 09:00 → the new week's.
  assert.equal(oncall.getCurrentShift('2026-07-16', 7)?.week_start, '2026-07-09');
  assert.equal(oncall.getCurrentShift('2026-07-16', 9)?.week_start, '2026-07-16');
});

test('createCoverage writes the row + coverage outbox INSERT + activity_log entry; getCoverage overlaps', () => {
  clearOutbox();
  const id = oncall.createCoverage({
    dateStart: '2026-07-20', dateEnd: '2026-07-24',
    userOff: FRANK, coveringUser: CORA, note: 'PTO', createdBy: 'u1',
  });

  // Range-overlap read (query range starts mid-coverage) with the name joins.
  const rows = oncall.getCoverage('2026-07-22', '2026-07-30');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].date_start, '2026-07-20');
  assert.equal(rows[0].date_end, '2026-07-24');
  assert.equal(rows[0].user_off_name, 'Frank');
  assert.equal(rows[0].covering_user_name, 'Cora');
  // Fully outside the coverage window → nothing.
  assert.equal(oncall.getCoverage('2026-08-01', '2026-08-05').length, 0);

  const ops = outboxEntries();
  const cov = ops.find(o => o.table_name === 'on_call_coverage');
  assert.ok(cov, 'coverage row must queue a sync op');
  assert.equal(cov.operation, 'INSERT');
  assert.deepEqual(
    Object.keys(cov.payload).sort(),
    ['covering_user', 'created_at', 'created_by', 'date_end', 'date_start', 'id', 'note', 'updated_at', 'user_off'].sort(),
  );
  assert.equal(cov.payload.id, id);
  assert.equal(cov.payload.user_off, FRANK);
  assert.equal(cov.payload.covering_user, CORA);

  const log = ops.find(o => o.table_name === 'activity_log');
  assert.ok(log, 'coverage creation must be logged');
  assert.equal(log.payload.action, 'on_call_coverage_added');
  assert.equal(log.payload.entity_type, 'team');
  // UUID-column trap: entity_id is a UUID column server-side — names/dates go
  // in note/metadata, never entity_id.
  assert.equal(log.payload.entity_id, null);
  assert.match(String(log.payload.note), /Cora/);
  assert.match(String(log.payload.note), /Frank/);
  const meta = JSON.parse(String(log.payload.metadata));
  assert.equal(meta.coverage_id, id);
  assert.equal(meta.user_off, FRANK);
  assert.equal(meta.covering_user, CORA);
});
