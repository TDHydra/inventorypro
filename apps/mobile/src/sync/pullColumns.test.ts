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

// api_request_audit (migration 042) holds cross-user PII and must never reach a device.
test('server-only tables are absent from the pull path', () => {
  for (const t of ['api_request_audit', 'telemetry_events']) {
    assert.ok(!SRC.includes(t), `pull.ts must not sync ${t}`);
  }
});
