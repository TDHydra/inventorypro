// Node-only stand-in for db/schema, swapped in by locationsShelf.test.ts via a
// module-hook redirect (op-sqlite is a native binding that can't load under
// `node --test`). Mirrors schema.web.ts's sql.js executeSync wrapper and
// schema.ts's rowsAs/bindParams so the query modules run unmodified against a
// real in-memory SQLite. Not a *.test.ts file: the test runner must not execute
// it directly, and tsc must typecheck it (tests are excluded from tsc).
import initSqlJs from 'sql.js';
import type { SqlDb } from '../types';

let db: SqlDb | null = null;

export function getDb(): SqlDb {
  if (!db) throw new Error('locationsShelf.testdb: initTestDb() has not run');
  return db;
}

export function rowsAs<T>(rows: unknown[]): T[] {
  return rows as unknown as T[];
}

type Bindable = string | number | null | ArrayBuffer;

// Same normalization as schema.ts (booleans → 1/0, objects → JSON, undefined → null).
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
// test (drop the table → the create fails → recreate it), so the DDL is exported.
export const OUTBOX_DDL = `
  CREATE TABLE outbox (
    id TEXT PRIMARY KEY, operation TEXT NOT NULL, table_name TEXT NOT NULL,
    payload TEXT NOT NULL, created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, synced_at TEXT
  );
`;

export async function initTestDb(): Promise<void> {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  db = {
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
  // Just the tables the locations helpers touch. taxonomy_types can stay empty:
  // resolveTypeId/getTypeLabelMap then resolve nothing, which is the grace path.
  db.executeSync(`
    CREATE TABLE locations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, color TEXT, icon TEXT,
      owner_user_id TEXT, active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
      synced_at TEXT, latitude REAL, longitude REAL,
      subareas_require_owner INTEGER NOT NULL DEFAULT 0,
      type TEXT, has_shelves INTEGER NOT NULL DEFAULT 0, type_id TEXT
    );
    CREATE TABLE taxonomy_types (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, label TEXT NOT NULL,
      icon TEXT, color TEXT, meta TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, updated_at TEXT
    );
    CREATE TABLE inventory_items (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE stock_by_location (
      item_id TEXT NOT NULL, location_id TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, synced_at TEXT,
      PRIMARY KEY (item_id, location_id)
    );
    ${OUTBOX_DDL}
  `);
}
