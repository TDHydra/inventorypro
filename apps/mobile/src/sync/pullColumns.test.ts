import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// pull.ts cannot be imported here: it pulls in db/schema -> op-sqlite (native),
// which will not load under `node --test`. So assert against its source text.
//
// Why this test exists: sync uses HARDCODED column lists (see
// docs/SYNC-MIGRATION-CHECKLIST.md). TABLE_UPSERT_SQL names N columns and N
// placeholders, and rowToValues must return exactly N values in the same order.
// A migration that adds a synced column and updates only one of the three is a
// runtime failure on the device ("N values for M columns"), never a compile error.
const SRC = readFileSync(join(dirname(new URL(import.meta.url).pathname), 'pull.ts'), 'utf8');

function upsertStatements(): Array<{ table: string; cols: string[]; placeholders: number }> {
  const out: Array<{ table: string; cols: string[]; placeholders: number }> = [];
  // e.g.  jobs: `INSERT OR REPLACE INTO jobs (a, b) VALUES (?,?)`,
  const re = /^\s*(\w+):\s*`INSERT OR REPLACE INTO \w+ \(([^)]*)\) VALUES \(([^)]*)\)`/gm;
  for (const m of SRC.matchAll(re)) {
    out.push({
      table: m[1],
      cols: m[2].split(',').map(s => s.trim()).filter(Boolean),
      placeholders: m[3].split(',').filter(s => s.trim() === '?').length,
    });
  }
  return out;
}

// The `case 'jobs': return [ ... ];` arm of rowToValues. Counting top-level commas
// (depth 0) so `x ?? null` and nested calls don't inflate the count.
function rowToValuesArity(table: string): number {
  const re = new RegExp(`case '${table}':\\s*return \\[`, 'm');
  const m = re.exec(SRC);
  assert.ok(m, `no rowToValues case for ${table}`);
  let i = m.index + m[0].length;
  let depth = 0;
  let count = 1;
  for (; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ']') {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) count++;
  }
  return count;
}

test('every TABLE_UPSERT_SQL has column count == placeholder count', () => {
  const stmts = upsertStatements();
  assert.ok(stmts.length > 15, `parsed only ${stmts.length} upserts — regex drifted`);
  for (const s of stmts) {
    assert.equal(
      s.cols.length, s.placeholders,
      `${s.table}: ${s.cols.length} columns but ${s.placeholders} placeholders`,
    );
  }
});

test('rowToValues returns one value per column, in lockstep with the upsert', () => {
  for (const s of upsertStatements()) {
    assert.equal(
      rowToValuesArity(s.table), s.cols.length,
      `${s.table}: upsert names ${s.cols.length} columns but rowToValues returns ${rowToValuesArity(s.table)} values`,
    );
  }
});

// Migration 035 / API 043. Guards the specific column this change added.
test('jobs syncs team_id', () => {
  const jobs = upsertStatements().find(s => s.table === 'jobs');
  assert.ok(jobs, 'no jobs upsert');
  assert.ok(jobs.cols.includes('team_id'), 'jobs upsert is missing team_id');
});

// Migration 041 / API 053 (#123). team_members gained the subteam columns — the
// exact "added a column to a synced table, updated only some of the three lists"
// trap docs/SYNC-MIGRATION-CHECKLIST.md documents.
test('team_members syncs subteam_id + subteam_role', () => {
  const tm = upsertStatements().find(s => s.table === 'team_members');
  assert.ok(tm, 'no team_members upsert');
  assert.ok(tm.cols.includes('subteam_id'), 'team_members upsert is missing subteam_id');
  assert.ok(tm.cols.includes('subteam_role'), 'team_members upsert is missing subteam_role');
});

// Migration 049 (role-dashboards spec §4/§5): users gained phone — the same
// "added a column to a synced table" trap as subteam_id/subteam_role above.
test('users syncs phone', () => {
  const users = upsertStatements().find(s => s.table === 'users');
  assert.ok(users, 'no users upsert');
  assert.ok(users.cols.includes('phone'), 'users upsert is missing phone');
});

// Migration 050 / API 062 (#157): vehicles gained checkout_locked — same
// "added a column to a synced table" trap as phone/subteam_id above.
test('vehicles syncs checkout_locked', () => {
  const vehicles = upsertStatements().find(s => s.table === 'vehicles');
  assert.ok(vehicles, 'no vehicles upsert');
  assert.ok(vehicles.cols.includes('checkout_locked'), 'vehicles upsert is missing checkout_locked');
});

// Field-crew epic (#122), migrations 041-044 / API 053-056: all six new tables
// must be in the pull path (parity with the server's FULL_TABLES).
test('field-crew tables are present in the pull path', () => {
  const tables = new Set(upsertStatements().map(s => s.table));
  for (const t of ['subteams', 'vehicles', 'vehicle_service_records', 'vehicle_checkouts', 'locker_access', 'on_call_shifts']) {
    assert.ok(tables.has(t), `pull.ts is missing the ${t} upsert`);
  }
});

// Migration 051 / API 063 (#160): job_assignments — new synced table; assert
// it's in the pull path with the full column set (parity with the server's
// JOB_ASSIGNMENTS_COLS projection).
test('job_assignments is present in the pull path with its full column set', () => {
  const ja = upsertStatements().find(s => s.table === 'job_assignments');
  assert.ok(ja, 'no job_assignments upsert');
  for (const c of ['id', 'job_id', 'assignee_kind', 'assignee_id', 'assigned_by', 'active', 'created_at', 'updated_at']) {
    assert.ok(ja.cols.includes(c), `job_assignments upsert is missing ${c}`);
  }
});

// api_request_audit (migration 042) holds cross-user PII and must never reach a device.
test('server-only tables are absent from the pull path', () => {
  for (const t of ['api_request_audit', 'telemetry_events']) {
    assert.ok(!SRC.includes(t), `pull.ts must not sync ${t}`);
  }
});

// Why this test exists: an incremental pull applies server rows in whatever
// order the server sends them, and locations.parent_id is a SELF-REFERENCING FK.
// A newly-created child arriving in the same batch as (or before) its parent
// blew up the whole cycle with "FOREIGN KEY constraint failed" — the sync then
// looked silently dead. The server owns FK integrity; a pull must not re-check it.
test('pull suspends FK enforcement while applying server rows and restores it', () => {
  const src = readFileSync(join(dirname(new URL(import.meta.url).pathname), 'pull.ts'), 'utf8');
  assert.ok(/PRAGMA foreign_keys\s*=\s*OFF/i.test(src),
    'pullChanges must disable FK enforcement before applying rows');
  assert.ok(/finally\s*{[^}]*PRAGMA foreign_keys\s*=\s*ON/is.test(src),
    'FK enforcement must be restored in a finally block');
});

// Migrations 053/054 / API 065/066 (phase 0, #152/#155/#167/#168): vehicles
// gained four option columns and service records gained receipt fields — the
// same "added a column to a synced table" trap as checkout_locked above.
test('vehicles syncs the phase-0 option columns', () => {
  const vehicles = upsertStatements().find(s => s.table === 'vehicles');
  assert.ok(vehicles, 'no vehicles upsert');
  for (const col of ['debris_option', 'debris_level', 'open_checkout', 'locked_by']) {
    assert.ok(vehicles.cols.includes(col), `vehicles upsert is missing ${col}`);
  }
});

test('vehicle_service_records syncs payer and job_id', () => {
  const recs = upsertStatements().find(s => s.table === 'vehicle_service_records');
  assert.ok(recs, 'no vehicle_service_records upsert');
  assert.ok(recs.cols.includes('payer'), 'missing payer');
  assert.ok(recs.cols.includes('job_id'), 'missing job_id');
});
