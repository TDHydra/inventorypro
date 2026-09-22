// Native DB bootstrap: op-sqlite opened here, handed to @invenpro/core via
// setDbProvider. op-sqlite's DB already satisfies core's SqlDb surface
// (executeSync → { rows }, close), so no wrapper is needed. Metro resolves
// this module to schema.web.ts on web (sql.js + IndexedDB persistence).
import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { setDbProvider, type SqlDb } from '@invenpro/core';
import { runMigrations } from './migrations';

export { bindParams, toBindable } from '@invenpro/core';

const DB_NAME = 'inventorypro.sqlite';

let db: DB | null = null;

export function getDb(): SqlDb {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db as unknown as SqlDb;
}

export async function initDb(): Promise<void> {
  db = open({ name: DB_NAME });
  runMigrations(db as unknown as SqlDb);
  setDbProvider(getDb);
}

export async function resetLocalDb(): Promise<void> {
  if (db) {
    db.close();
    db = null;
  }
  db = open({ name: DB_NAME });
  const tables = db.executeSync(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  ).rows as { name: string }[];
  db.executeSync('PRAGMA foreign_keys = OFF');
  for (const { name } of tables) {
    db.executeSync(`DROP TABLE IF EXISTS "${name}"`);
  }
  db.executeSync('PRAGMA foreign_keys = ON');
  runMigrations(db as unknown as SqlDb);
}

// Accepts any array (raw op-sqlite rows or pre-typed query results).
export function rowsAs<T>(rows: unknown[]): T[] {
  return rows as unknown as T[];
}
