// The migration CHAIN, run for real against sql.js (the same engine Expo Web
// uses), because the two paths through it diverge and only one of them is
// exercised by a fresh `pnpm start`:
//
//   fresh install  → 001 builds the baseline from the CURRENT manifest, which
//                    already carries every column a later migration adds;
//   upgrading app  → 001 ran months ago against an OLDER manifest, so the
//                    later migration is the only thing that adds the column.
//
// An unguarded `ALTER TABLE … ADD COLUMN` is fine on the second path and FATAL
// on the first ("duplicate column name" → the runner rolls back and the app
// cannot open its database at all). This file pins both.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { baselineDdl, type SqlDb } from '@invenpro/core';
import { MIGRATIONS, hasColumn, runMigrations } from './index';

type RawDb = { exec: (sql: string) => { columns: string[]; values: unknown[][] }[]; run: (sql: string, p?: unknown[]) => void };

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

before(async () => {
  SQL = await initSqlJs();
});

/** A sql.js database behind the same minimal SqlDb surface the app's schema.ts
 *  and schema.web.ts hand to runMigrations. */
function freshDb(): { db: SqlDb; raw: RawDb } {
  const raw = new SQL.Database() as unknown as RawDb;
  const db: SqlDb = {
    executeSync: (sql: string, params?: unknown[]) => {
      const res = raw.exec(sql.replace(/\?/g, () => {
        const v = (params ?? []).shift();
        return v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
      }));
      const rows = (res[0]?.values ?? []).map(v => {
        const obj: Record<string, unknown> = {};
        res[0].columns.forEach((c, i) => { obj[c] = v[i]; });
        return obj;
      });
      return { rows } as ReturnType<SqlDb['executeSync']>;
    },
    close: () => {},
  } as SqlDb;
  return { db, raw };
}

function columnsOf(db: SqlDb, table: string): string[] {
  return (db.executeSync(`PRAGMA table_info(${table})`).rows as { name: string }[]).map(r => r.name);
}

function schemaVersion(db: SqlDb): number {
  const row = db.executeSync(`SELECT value FROM app_settings WHERE key = 'schema_version'`)
    .rows[0] as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

const LATEST = Math.max(...MIGRATIONS.map(m => m.version));

test('FRESH install: the whole chain runs over a manifest baseline that already has the new columns', () => {
  const { db } = freshDb();
  runMigrations(db);
  assert.equal(schemaVersion(db), LATEST);
  assert.ok(columnsOf(db, 'locations').includes('sort_order'));
});

test('runMigrations is idempotent — a second call does nothing', () => {
  const { db } = freshDb();
  runMigrations(db);
  runMigrations(db);
  assert.equal(schemaVersion(db), LATEST);
  // One sort_order, not two.
  assert.equal(columnsOf(db, 'locations').filter(c => c === 'sort_order').length, 1);
});

test('UPGRADING install: a v1 database with no sort_order gains it, LAST', () => {
  const { db } = freshDb();
  // Replay the v1 world: the baseline as it was BEFORE #290, i.e. locations
  // without sort_order, stamped at schema_version 1.
  for (const stmt of baselineDdl()) {
    db.executeSync(stmt.includes('CREATE TABLE IF NOT EXISTS locations')
      ? stmt.replace(', sort_order INTEGER NOT NULL DEFAULT 0', '')
      : stmt);
  }
  db.executeSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', '1')`);
  assert.ok(!hasColumn(db, 'locations', 'sort_order'), 'precondition: the v1 shape');

  runMigrations(db);
  assert.equal(schemaVersion(db), LATEST);
  const cols = columnsOf(db, 'locations');
  assert.equal(cols[cols.length - 1], 'sort_order',
    'appended last, so an upgraded device matches a fresh install column-for-column');
});

test('UPGRADING install: existing rows default to 0 (no backfill, no reshuffle)', () => {
  const { db } = freshDb();
  for (const stmt of baselineDdl()) {
    db.executeSync(stmt.includes('CREATE TABLE IF NOT EXISTS locations')
      ? stmt.replace(', sort_order INTEGER NOT NULL DEFAULT 0', '')
      : stmt);
  }
  db.executeSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', '1')`);
  db.executeSync(`INSERT INTO locations (id, name, active, updated_at, type) VALUES ('s1', 'B1', 1, '2026-01-01T00:00:00Z', 'Shelf')`);
  db.executeSync(`INSERT INTO locations (id, name, active, updated_at, type) VALUES ('s2', 'A1', 1, '2026-01-01T00:00:00Z', 'Shelf')`);

  runMigrations(db);
  const rows = db.executeSync(`SELECT name, sort_order FROM locations ORDER BY sort_order, name`).rows as
    { name: string; sort_order: number }[];
  assert.deepEqual(rows, [{ name: 'A1', sort_order: 0 }, { name: 'B1', sort_order: 0 }],
    'every pre-existing shelf starts at 0, so the list still reads alphabetically');
});

test('every migration past 001 guards its ALTERs with hasColumn', () => {
  // A regression fence for the trap above: the chain is short enough to read,
  // and the cost of forgetting the guard is an app that cannot open its DB.
  for (const m of MIGRATIONS.filter(x => x.version > 1)) {
    const src = m.up.toString();
    const alters = src.match(/ADD COLUMN/g) ?? [];
    if (alters.length === 0) continue;
    assert.ok(src.includes('hasColumn'),
      `migration v${m.version} adds a column without a hasColumn guard`);
  }
});
