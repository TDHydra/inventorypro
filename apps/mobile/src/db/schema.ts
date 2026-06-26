import { open, DB } from '@op-engineering/op-sqlite';

let db: DB | null = null;

export function getDb(): DB {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export async function initDb(): Promise<void> {
  db = open({ name: 'inventorypro.sqlite' });
  await runMigrations(db);
}

export async function resetLocalDb(): Promise<void> {
  if (db) {
    db.close();
    db = null;
  }
  // Re-open fresh (file will be recreated)
  db = open({ name: 'inventorypro.sqlite' });
  // Drop all tables
  const tables = db.executeSync(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).rows as { name: string }[];

  db.executeSync('PRAGMA foreign_keys = OFF');
  for (const { name } of tables) {
    db.executeSync(`DROP TABLE IF EXISTS "${name}"`);
  }
  db.executeSync('PRAGMA foreign_keys = ON');
  await runMigrations(db);
}

async function runMigrations(database: DB): Promise<void> {
  // Bootstrap: create app_settings table if needed
  database.executeSync(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const versionRow = database.executeSync(
    `SELECT value FROM app_settings WHERE key = 'schema_version'`
  ).rows[0] as { value: string } | undefined;

  const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

  // Import all migrations dynamically
  const migrations = await loadMigrations();
  const pending = migrations.filter(m => m.version > currentVersion);

  if (pending.length === 0) {
    console.log(`[DB] SQLite schema v${currentVersion} ready`);
    return;
  }

  for (const migration of pending) {
    console.log(`[DB] Applying SQLite migration v${migration.version}...`);
    database.executeSync('BEGIN');
    try {
      migration.up(database);
      database.executeSync(
        `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', ?)`,
        [String(migration.version)]
      );
      database.executeSync('COMMIT');
      console.log(`[DB] ✓ SQLite migration v${migration.version} applied`);
    } catch (err) {
      database.executeSync('ROLLBACK');
      throw new Error(`SQLite migration v${migration.version} failed: ${(err as Error).message}`);
    }
  }

  console.log(`[DB] SQLite schema v${pending[pending.length - 1].version} ready`);
}

interface Migration {
  version: number;
  up: (db: DB) => void;
}

async function loadMigrations(): Promise<Migration[]> {
  // Statically import migrations to work with Metro bundler
  const { migration: m001 } = await import('./migrations/001_initial');
  const { migration: m002 } = await import('./migrations/002_inventory_fields');
  const { migration: m003 } = await import('./migrations/003_user_pin_set');
  const { migration: m004 } = await import('./migrations/004_inventory_kind_location_owner');
  const { migration: m005 } = await import('./migrations/005_item_category_returnable');
  const { migration: m006 } = await import('./migrations/006_equipment_units');
  return [m001, m002, m003, m004, m005, m006].sort((a, b) => a.version - b.version);
}

// Type-safe cast helper — accepts any array (raw op-sqlite rows or pre-typed query results)
export function rowsAs<T>(rows: unknown[]): T[] {
  return rows as unknown as T[];
}

type Bindable = string | number | null | ArrayBuffer;

// op-sqlite only binds string | number | null | ArrayBuffer. The API returns
// JSONB columns as JS objects and bool columns as true/false, both of which
// throw "object is not an arrayBuffer or array buffer view" if bound directly.
// Normalize: booleans → 1/0, objects/arrays → JSON string, undefined → null.
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
