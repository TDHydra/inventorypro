import { baselineDdl, type SqlDb } from '@invenpro/core';

// ONE migration list for BOTH platforms — schema.ts (op-sqlite) and
// schema.web.ts (sql.js) import this same array, which structurally kills the
// old app's twin-array gotcha (native and web each maintained their own
// 67-entry import list that could drift).
//
// v2 starts fresh: migration 001 is the ENTIRE baseline, derived at runtime
// from the checked-in table manifest (packages/core/src/manifest/tables.ts).
// There is no generated DDL file to drift from the manifest — the manifest IS
// the artifact. New v2 migrations append here as 002, 003, … and must be
// additive (the manifest gains the same columns so fresh installs and
// upgraders converge on identical schemas — asserted by core's baseline test).

export interface Migration {
  version: number;
  up: (db: SqlDb) => void;
}

/**
 * True when `table` already has `column`.
 *
 * Every additive migration here MUST guard its ALTER with this. Migration 001
 * builds the baseline from the CURRENT manifest, which also carries the column
 * the later migration adds — so on a FRESH install the column already exists by
 * the time 002 runs, and an unguarded `ALTER TABLE … ADD COLUMN` would fail
 * with "duplicate column name" and roll the whole install back. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`.
 */
export function hasColumn(db: SqlDb, table: string, column: string): boolean {
  const rows = db.executeSync(`PRAGMA table_info(${table})`).rows as { name: string }[];
  return rows.some(r => r.name === column);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: db => {
      for (const stmt of baselineDdl()) db.executeSync(stmt);
    },
  },
  {
    // #290 shelf management: manual shelf order within a location. Appended
    // LAST so an upgrading device ends up with the same column order a fresh
    // install gets from the manifest baseline (asserted by core's
    // baseline.test.ts). No backfill: every row starts at 0 and shelf lists
    // order by `sort_order, name`, so nothing visibly changes until someone
    // reorders a parent's shelves — which renumbers that parent 0..n-1.
    version: 2,
    up: db => {
      if (!hasColumn(db, 'locations', 'sort_order')) {
        db.executeSync(`ALTER TABLE locations ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
      }
    },
  },
];

/**
 * Shared migration runner (ported from the old schema.ts, identical
 * semantics): app_settings bootstrap, schema_version watermark, one
 * BEGIN/COMMIT per migration with ROLLBACK + rethrow on failure.
 */
export function runMigrations(db: SqlDb): void {
  db.executeSync(
    `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  const versionRow = db
    .executeSync(`SELECT value FROM app_settings WHERE key = 'schema_version'`)
    .rows[0] as { value: string } | undefined;
  const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

  const pending = MIGRATIONS.filter(m => m.version > currentVersion).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) {
    console.log(`[DB] schema v${currentVersion} ready`);
    return;
  }

  for (const migration of pending) {
    db.executeSync('BEGIN');
    try {
      migration.up(db);
      db.executeSync(
        `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', ?)`,
        [String(migration.version)],
      );
      db.executeSync('COMMIT');
      console.log(`[DB] ✓ migration v${migration.version} applied`);
    } catch (err) {
      db.executeSync('ROLLBACK');
      throw new Error(`migration v${migration.version} failed: ${(err as Error).message}`);
    }
  }
}
