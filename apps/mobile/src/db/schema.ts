import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';

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
  const { migration: m007 } = await import('./migrations/007_location_active');
  const { migration: m008 } = await import('./migrations/008_job_workorder_fields');
  const { migration: m009 } = await import('./migrations/009_location_coords');
  const { migration: m010 } = await import('./migrations/010_app_config');
  const { migration: m011 } = await import('./migrations/011_taxonomy_types');
  const { migration: m012 } = await import('./migrations/012_product_classes_owner');
  const { migration: m013 } = await import('./migrations/013_hardening');
  const { migration: m014 } = await import('./migrations/014_role_permissions');
  const { migration: m015 } = await import('./migrations/015_team_managers');
  const { migration: m016 } = await import('./migrations/016_job_insurance');
  const { migration: m017 } = await import('./migrations/017_location_types_item_home');
  const { migration: m018 } = await import('./migrations/018_item_pack_size');
  const { migration: m019 } = await import('./migrations/019_repairs');
  const { migration: m020 } = await import('./migrations/020_location_has_shelves');
  const { migration: m021 } = await import('./migrations/021_taxonomy_dedup');
  const { migration: m022 } = await import('./migrations/022_role_color');
  const { migration: m023 } = await import('./migrations/023_repair_fields_parts');
  const { migration: m024 } = await import('./migrations/024_telemetry_buffer');
  const { migration: m025 } = await import('./migrations/025_notifications_and_approvals');
  const { migration: m026 } = await import('./migrations/026_drop_teams_manager_id');
  const { migration: m027 } = await import('./migrations/027_equipment_lifecycle');
  const { migration: m028 } = await import('./migrations/028_label_templates');
  const { migration: m029 } = await import('./migrations/029_taxonomy_fk');
  const { migration: m030 } = await import('./migrations/030_location_subtypes');
  const { migration: m031 } = await import('./migrations/031_repairs_status_fk');
  const { migration: m032 } = await import('./migrations/032_user_email');
  const { migration: m033 } = await import('./migrations/033_dashboards');
  const { migration: m034 } = await import('./migrations/034_chat');
  const { migration: m035 } = await import('./migrations/035_jobs_team_id');
  const { migration: m036 } = await import('./migrations/036_media_hub');
  const { migration: m037 } = await import('./migrations/037_test_accounts');
  const { migration: m038 } = await import('./migrations/038_equipment_type');
  const { migration: m039 } = await import('./migrations/039_message_edits');
  const { migration: m040 } = await import('./migrations/040_user_prefs');
  const { migration: m041 } = await import('./migrations/041_subteams');
  const { migration: m042 } = await import('./migrations/042_vehicles');
  const { migration: m043 } = await import('./migrations/043_locker_access');
  const { migration: m044 } = await import('./migrations/044_on_call');
  const { migration: m045 } = await import('./migrations/045_two_tanks');
  const { migration: m046 } = await import('./migrations/046_unit_access');
  const { migration: m047 } = await import('./migrations/047_flatten_and_dedupe');
  const { migration: m048 } = await import('./migrations/048_on_call_coverage');
  const { migration: m049 } = await import('./migrations/049_user_phone');
  const { migration: m050 } = await import('./migrations/050_vehicle_checkout_lock');
  const { migration: m051 } = await import('./migrations/051_job_assignments');
  const { migration: m052 } = await import('./migrations/052_media_audience');
  const { migration: m053 } = await import('./migrations/053_vehicle_options');
  const { migration: m054 } = await import('./migrations/054_receipt_fields');
  return [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016, m017, m018, m019, m020, m021, m022, m023, m024, m025, m026, m027, m028, m029, m030, m031, m032, m033, m034, m035, m036, m037, m038, m039, m040, m041, m042, m043, m044, m045, m046, m047, m048, m049, m050, m051, m052, m053, m054].sort((a, b) => a.version - b.version);
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
