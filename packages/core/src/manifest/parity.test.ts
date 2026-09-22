// Contract-parity test (Phase 1 of the lean rebuild — DELETE in Phase 10 when
// apps/mobile and the old API are removed).
//
// Proves the manifest reproduces the OLD 4-way-duplicated sync contract exactly:
//   1. upsert SQL string-equals pull.ts TABLE_UPSERT_SQL      (per table)
//   2. rowToValues value-equals pull.ts rowToValues           (probed rows)
//   3. full-download order equals fullDownload.ts SYNC_TABLES (minus dropped)
//   4. server flag sets equal routes/sync.ts ALLOWED/CONFLICT/PRIVILEGED/…
//
// The old files are read as TEXT (pull.ts imports op-sqlite, which cannot load
// under node) and the legacy rowToValues is evaluated in isolation — it is a
// pure function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TABLES } from './tables';
import {
  PULL_TABLES, FULL_DOWNLOAD_TABLES, PUSH_TABLES, DELETE_FORBIDDEN_TABLES,
  INSERT_NO_UPSERT_TABLES, PRIVILEGED_TABLE_PERM, CONFLICT_TARGETS,
  upsertSql, rowToValues,
} from './derive';

const REPO = join(__dirname, '../../../..');
const PULL_SRC = readFileSync(join(REPO, 'apps/mobile/src/sync/pull.ts'), 'utf8');
const FULL_SRC = readFileSync(join(REPO, 'apps/mobile/src/sync/fullDownload.ts'), 'utf8');
const SYNC_SRC = readFileSync(join(REPO, 'apps/api/src/routes/sync.ts'), 'utf8');

// Tables intentionally dropped from the rebuild (dead / de-scoped): the old
// contract still carries them, so every comparison filters them out.
const DROPPED = new Set(['locker_access', 'dashboard_presets']);

// ── extract legacy artifacts ────────────────────────────────────────────────
const oldUpsertSql: Record<string, string> = {};
for (const m of PULL_SRC.matchAll(/(\w+): `(INSERT OR REPLACE INTO (\w+) \([^`]+)`/g)) {
  oldUpsertSql[m[3]] = m[2];
}

const fnStart = PULL_SRC.indexOf('function rowToValues');
const fnEnd = PULL_SRC.indexOf('function getLastPulledAt');
const fnSrc = PULL_SRC.slice(fnStart, fnEnd).replace(
  'function rowToValues(table: string, row: Record<string, unknown>): unknown[] {',
  'function rowToValues(table, row) {');
// eslint-disable-next-line no-new-func
const oldRowToValues = new Function(`${fnSrc}; return rowToValues;`)() as
  (t: string, r: Record<string, unknown>) => unknown[];

function extractSet(src: string, name: string): string[] {
  const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(m, `could not find ${name}`);
  return [...stripComments(m[1]).matchAll(/'([^']+)'/g)].map(x => x[1]);
}
function extractRecord(src: string, name: string): Record<string, string> {
  const m = src.match(new RegExp(`const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(m, `could not find ${name}`);
  const out: Record<string, string> = {};
  for (const x of m[1].matchAll(/^\s*(\w+):\s*'([^']+)'/gm)) out[x[1]] = x[2];
  return out;
}

const norm = (s: string) =>
  s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/,\s+/g, ',').trim();

/** Drop // comments before quote-scraping (they contain apostrophes). */
const stripComments = (s: string) => s.replace(/\/\/[^\n]*/g, '');

// ── 1+2: pull contract per table ────────────────────────────────────────────
const PROBE_ROWS: Record<string, unknown>[] = [
  {},
  // fallbackCol case (media.updated_at ?? created_at)
  { created_at: '2026-01-01T00:00:00Z' },
];

test('manifest covers exactly the old pull tables minus dropped', () => {
  const oldTables = Object.keys(oldUpsertSql).filter(t => !DROPPED.has(t)).sort();
  const newTables = PULL_TABLES.map(t => t.name).sort();
  assert.deepEqual(newTables, oldTables);
});

for (const spec of PULL_TABLES) {
  test(`upsert SQL parity: ${spec.name}`, () => {
    assert.equal(norm(upsertSql(spec)), norm(oldUpsertSql[spec.name]));
  });

  test(`rowToValues parity: ${spec.name}`, () => {
    const cols = (spec.pullColumns ?? []).map(c => c.name);
    const probes = [
      ...PROBE_ROWS,
      Object.fromEntries(cols.map(c => [c, false])),
      Object.fromEntries(cols.map(c => [c, 'x'])),
      Object.fromEntries(cols.map(c => [c, 5])),
      Object.fromEntries(cols.map(c => [c, { k: 1 }])),
      Object.fromEntries(cols.map(c => [c, null])),
    ];
    for (const row of probes) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(rowToValues(spec, row) ?? null)),
        JSON.parse(JSON.stringify(oldRowToValues(spec.name, row) ?? null)),
        `row=${JSON.stringify(row).slice(0, 80)}`,
      );
    }
  });
}

// ── 3: full-download order ──────────────────────────────────────────────────
test('full-download order equals old SYNC_TABLES minus dropped', () => {
  const m = FULL_SRC.match(/const SYNC_TABLES = \[([\s\S]*?)\] as const/);
  assert.ok(m);
  const oldOrder = [...stripComments(m[1]).matchAll(/'([^']+)'/g)].map(x => x[1]).filter(t => !DROPPED.has(t));
  assert.deepEqual(FULL_DOWNLOAD_TABLES, oldOrder);
});

// ── 4: server flag sets ─────────────────────────────────────────────────────
test('push allowlist equals old ALLOWED_TABLES minus dropped', () => {
  const old = extractSet(SYNC_SRC, 'ALLOWED_TABLES').filter(t => !DROPPED.has(t)).sort();
  assert.deepEqual([...PUSH_TABLES].sort(), old);
});

test('delete-forbidden set parity', () => {
  assert.deepEqual([...DELETE_FORBIDDEN_TABLES].sort(),
    extractSet(SYNC_SRC, 'DELETE_FORBIDDEN_TABLES').sort());
});

test('insert-no-upsert set parity', () => {
  assert.deepEqual([...INSERT_NO_UPSERT_TABLES].sort(),
    extractSet(SYNC_SRC, 'INSERT_NO_UPSERT').sort());
});

test('privileged-table permission map parity', () => {
  assert.deepEqual(PRIVILEGED_TABLE_PERM, extractRecord(SYNC_SRC, 'PRIVILEGED_TABLE_PERM'));
});

test('conflict targets parity (dropped tables removed; id defaults added)', () => {
  const old = extractRecord(SYNC_SRC, 'CONFLICT_TARGETS');
  for (const [table, target] of Object.entries(old)) {
    if (DROPPED.has(table)) continue;
    assert.equal(CONFLICT_TARGETS[table]?.replace(/\s+/g, ' '), target.replace(/\s+/g, ' '),
      `conflict target for ${table}`);
  }
  // Every other pushable table must default to plain `id` (old sync.ts fell
  // back to `id` when the map had no entry).
  for (const t of PUSH_TABLES) {
    if (old[t] || DROPPED.has(t)) continue;
    assert.equal(CONFLICT_TARGETS[t], 'id', `default conflict target for ${t}`);
  }
});
