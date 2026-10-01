// Jest stand-in for src/db/schema, swapped in by jest.config.js's
// moduleNameMapper (op-sqlite is a native binding that can't load under jest).
//
// Deliberately NOT a mock: it is a REAL sql.js database created from the
// @invenpro/core manifest DDL, same as src/repos/testDb.ts does for the
// `node --test` repo suites. Page render tests therefore exercise the actual
// repo query paths (searchItems, getJob, ...) rather than 40 hand-written
// jest.fn()s that drift from the real signatures.
//
// Two deliberate differences from src/repos/testDb.ts:
//
// 1. Table set. That harness takes an explicit list per suite, because a repo
//    suite knows the two or three tables it touches. A page pulls in an unknown
//    transitive set of repos, so this creates EVERY manifest table up front and
//    exposes reset/seed helpers instead.
//
// 2. Engine: better-sqlite3, not sql.js. sql.js CANNOT run under jest-expo.
//    The preset installs @react-native/jest-preset's custom resolver, which
//    resolves with the "browser" export condition and stubs node builtins; sql.js
//    then picks its browser build and its Emscripten runtime comes up with an
//    unusable heap, so the very first `new SQL.Database()` fails with sqlite
//    "out of memory" (SQLITE_CANTOPEN). Verified by bisection: bare jest + the
//    RN test environment is fine, `preset: 'jest-expo'` alone reproduces it.
//    better-sqlite3 is real SQLite, synchronous (so it fits SqlDb.executeSync
//    with no async plumbing), and devDependency-only — it is never bundled into
//    the app. The `node --test` suites keep using sql.js and are untouched.
import Database from 'better-sqlite3';
import {
  setDbProvider, configureCore, getTableSpec, tableDdl, TABLES, type SqlDb,
} from '@invenpro/core';

export { bindParams, toBindable } from '@invenpro/core';

let db: SqlDb | null = null;
let uuidCounter = 0;

export function getDb(): SqlDb {
  if (!db) {
    throw new Error(
      'pageTestDb: no database. test/jest.setup.ts installs a global beforeAll ' +
      'that calls initPageDb(); a test that bypasses the setup file must call it itself.',
    );
  }
  return db;
}

export function rowsAs<T>(rows: unknown[]): T[] {
  return rows as unknown as T[];
}

/** schema.ts's initDb opens the native DB and runs migrations; both are already
 *  done by initPageDb (manifest DDL), so a page calling it is a no-op. */
export async function initDb(): Promise<void> {}

export async function resetLocalDb(): Promise<void> {
  await initPageDb();
}

/** Drop and recreate every manifest table. Called per test file by the global
 *  beforeAll so one page's seeded rows can't leak into the next file. */
// Async only to keep the call shape identical to src/repos/testDb.ts's
// initTestDb (and to leave room for async seeding); better-sqlite3 itself is
// fully synchronous.
export async function initPageDb(): Promise<void> {
  const raw = new Database(':memory:');
  const instance: SqlDb = {
    executeSync(sql: string, params?: unknown[]) {
      const bound = (params ?? []) as never[];
      // DDL arrives as one statement per string from tableDdl(), but a repo may
      // still send a multi-statement script; prepare() rejects those, exec()
      // takes them and returns nothing — which is correct for DDL.
      if (bound.length === 0 && /;\s*\S/.test(sql.trim().replace(/;\s*$/, ''))) {
        raw.exec(sql);
        return { rows: [] };
      }
      const stmt = raw.prepare(sql);
      // `reader` is true for anything that returns rows (SELECT, RETURNING,
      // PRAGMA). run() on a reader throws, all() on a writer throws, so the
      // branch is required rather than defensive.
      return { rows: stmt.reader ? (stmt.all(...bound) as Record<string, unknown>[]) : (stmt.run(...bound), []) };
    },
    close() { raw.close(); },
  };

  if (db) { try { db.close(); } catch { /* already closed */ } }
  db = instance;

  for (const spec of TABLES) {
    for (const ddl of tableDdl(spec)) instance.executeSync(ddl);
  }

  // Wire @invenpro/core's own provider seam to the SAME instance, so
  // createRepository()/mirror()/appendOutbox() read and write this database
  // (see the note at the top of src/repos/testDb.ts).
  setDbProvider(() => instance);

  uuidCounter = 0;
  configureCore({
    apiBase: 'http://test.local',
    generateUUID: () => `uuid-${String(++uuidCounter).padStart(4, '0')}`,
    auth: {
      getValidJwt: async () => 'test-jwt',
      revalidateSession: async () => undefined,
      getSavedUserId: async () => 'user-1',
    },
  });
}

/**
 * Insert a fixture row. Keeps page tests readable:
 *   seed('inventory_items', { id: 'i1', name: 'Hammer' })
 *
 * Foreign keys are suspended for the insert and restored afterwards, so a test
 * can seed the one row its screen renders without also constructing the whole
 * referenced graph (a job's created_by user, its site location, its team...).
 * This is not a shortcut around the real schema — it is exactly what the app
 * does when it writes rows it did not author: packages/core/src/sync/pull.ts
 * and fullDownload.ts both bracket their writes with
 * `PRAGMA foreign_keys = OFF` / `= ON`, and seeding is the test-time analogue
 * of a sync pull. The RENDER still runs with foreign keys ON, matching
 * db/schema.ts, so a screen whose own writes violate a constraint still fails.
 *
 * better-sqlite3 enforces foreign keys by default; sql.js does not, which is
 * why src/repos/testDb.ts never needed this.
 */
export function seed(table: string, row: Record<string, unknown>): void {
  if (!getTableSpec(table)) throw new Error(`pageTestDb: no manifest spec for table ${table}`);
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const db = getDb();
  db.executeSync('PRAGMA foreign_keys = OFF');
  try {
    db.executeSync(
      `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
      cols.map((c) => normalize(row[c])),
    );
  } finally {
    db.executeSync('PRAGMA foreign_keys = ON');
  }
}

function normalize(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return JSON.stringify(value);
}
