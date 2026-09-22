// Node-only stand-in for db/schema, swapped in by rooms.test.ts /
// taxonomyIcon.test.ts / locationsShelf.test.ts via a module-hook redirect
// (op-sqlite is a native binding that can't load under `node --test`).
// Unlike the old app's locationsShelf.testdb.ts, this ALSO wires up
// @invenpro/core's db provider + configureCore — repos/locations.ts,
// repos/rooms.ts, and repos/taxonomy.ts all write through createRepository()/
// mirror(), which reach into @invenpro/core's OWN getDb() (db/provider.ts),
// not this module's getDb(); both must resolve to the exact same underlying
// sql.js database, and appendOutbox() needs configureCore() (generateUUID,
// assertWritable) before any write path runs.
//
// Table DDL is pulled verbatim from the manifest (packages/core/src/manifest)
// via getTableSpec/tableDdl — the same primitives packages/core/src/test/
// helpers.ts uses — rather than hand-copied, so the in-memory schema always
// matches the real one. Not a *.test.ts file: the test runner must not execute
// it directly, and tsc must typecheck it (tests are excluded from tsc).
import initSqlJs from 'sql.js';
import { setDbProvider, configureCore, getTableSpec, tableDdl, type SqlDb } from '@invenpro/core';

let db: SqlDb | null = null;

export function getDb(): SqlDb {
  if (!db) throw new Error('testDb: initTestDb() has not run');
  return db;
}

export function rowsAs<T>(rows: unknown[]): T[] {
  return rows as unknown as T[];
}

type Bindable = string | number | null | ArrayBuffer;

// Same normalization as db/schema.ts / @invenpro/core's toBindable (booleans →
// 1/0, objects → JSON, undefined → null).
export function toBindable(value: unknown): Bindable {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value as ArrayBuffer;
  return JSON.stringify(value);
}

export function bindParams(params: readonly unknown[]): Bindable[] {
  return params.map(toBindable);
}

// findOrCreateShelf's outbox write is the failure lever for the __new__-failure
// test (drop the table → the create fails → recreate it), so the DDL is
// exported. Pulled from the manifest rather than hand-copied.
export function outboxDdl(): string[] {
  const spec = getTableSpec('outbox');
  if (!spec) throw new Error('testDb: no manifest spec for outbox');
  return tableDdl(spec);
}

let uuidCounter = 0;

export async function initTestDb(tables: string[]): Promise<void> {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  const instance: SqlDb = {
    executeSync(sql: string, params?: unknown[]) {
      const rows: Record<string, unknown>[] = [];
      if (params && params.length > 0) {
        const stmt = raw.prepare(sql);
        stmt.bind(params as never[]);
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
      } else {
        for (const r of raw.exec(sql)) {
          for (const v of r.values) {
            const obj: Record<string, unknown> = {};
            r.columns.forEach((c, i) => { obj[c] = v[i]; });
            rows.push(obj);
          }
        }
      }
      return { rows };
    },
    close() { raw.close(); },
  };
  db = instance;

  for (const t of tables) {
    const spec = getTableSpec(t);
    if (!spec) throw new Error(`testDb: no manifest spec for test table ${t}`);
    for (const ddl of tableDdl(spec)) instance.executeSync(ddl);
  }

  // Wire @invenpro/core's own provider seam to the SAME instance so
  // createRepository()/mirror()/appendOutbox() read and write this database.
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
