// src/db/schema.web.ts
import initSqlJs, { type Database } from 'sql.js';
import type { SqlDb } from './types';
import { loadDbSnapshot, saveDbSnapshot, clearDbSnapshot } from './webPersistence';

let raw: Database | null = null;       // sql.js Database
let wrapped: SqlDb | null = null;
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export let persistenceDisabled = false; // surfaced to UI for the "won't save" banner

// Set true by an idle/logout wipe (markDbWiped). While wiped, ALL snapshot
// persistence is blocked so a stray debounced flush — or the migration flush
// inside resetLocalDb() — can't call getOrCreateSnapshotKey(), re-mint a fresh
// AES key, and re-write a decryptable snapshot, silently undoing the wipe. It is
// cleared again by clearDbWiped() only on a genuine re-login (saveSession).
let persistWiped = false;

function isRead(sql: string): boolean {
  const head = sql.trim().slice(0, 8).toUpperCase();
  return head.startsWith('SELECT') || head.startsWith('PRAGMA') || head.startsWith('EXPLAIN');
}

function scheduleSave() {
  if (persistenceDisabled || persistWiped || !raw) return;
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void flush(); }, 500);
}

async function flush(): Promise<void> {
  if (!dirty || !raw || persistenceDisabled || persistWiped) return;
  dirty = false;
  try { await saveDbSnapshot(raw.export()); }
  catch { persistenceDisabled = true; }
}

// Build the op-sqlite-compatible wrapper. executeSync returns { rows: object[] }.
function wrap(database: Database): SqlDb {
  return {
    executeSync(sql: string, params?: unknown[]) {
      const rows: any[] = [];
      if (params && params.length > 0) {
        // Single parameterized statement → prepared statement.
        const stmt = database.prepare(sql);
        stmt.bind(params as any[]);
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
      } else {
        // No params: may be multi-statement DDL (migrations) → exec.
        const res = database.exec(sql);
        for (const r of res) {
          for (const v of r.values) {
            const obj: Record<string, unknown> = {};
            r.columns.forEach((c, i) => { obj[c] = v[i]; });
            rows.push(obj);
          }
        }
      }
      if (!isRead(sql)) scheduleSave();
      return { rows };
    },
    close() { void flush(); database.close(); },
  };
}

export function getDb(): SqlDb {
  if (!wrapped) throw new Error('Database not initialized. Call initDb() first.');
  return wrapped;
}

export async function initDb(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: (f: string) => '/' + f });
  let snapshot: Uint8Array | null = null;
  try { snapshot = await loadDbSnapshot(); }
  catch { persistenceDisabled = true; }
  raw = snapshot ? new SQL.Database(snapshot) : new SQL.Database();
  wrapped = wrap(raw);
  await runMigrations(wrapped);
  installFlushHooks();
}

export async function resetLocalDb(): Promise<void> {
  if (raw) { raw.close(); raw = null; wrapped = null; }
  try { await clearDbSnapshot(); } catch { /* ignore */ }
  await initDb();
}

/**
 * Block all snapshot persistence until the next genuine re-login. Called at the
 * START of an idle/logout wipe (before wipeWebSecureState/resetLocalDb) so that a
 * pending debounced flush of the still-live, data-bearing DB — or the migration
 * flush that runs inside the subsequent resetLocalDb() — cannot re-mint an AES
 * key and re-persist a decryptable snapshot. The pending save timer is cancelled
 * and the dirty flag cleared so nothing already queued slips through.
 */
export function markDbWiped(): void {
  persistWiped = true;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  dirty = false;
}

/** Re-enable snapshot persistence after a genuine re-login (saveSession). */
export function clearDbWiped(): void {
  persistWiped = false;
}

let hooksInstalled = false;
function installFlushHooks() {
  if (hooksInstalled || typeof window === 'undefined') return;
  hooksInstalled = true;
  // Flush before the tab is hidden/closed so a refresh never loses writes.
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush(); });
  window.addEventListener('pagehide', () => { void flush(); });
}

// ── migrations (mirrors schema.ts; uses the same migration modules) ──────────
interface Migration { version: number; up: (db: SqlDb) => void; }

async function loadMigrations(): Promise<Migration[]> {
  const m = await Promise.all([
    import('./migrations/001_initial'), import('./migrations/002_inventory_fields'),
    import('./migrations/003_user_pin_set'), import('./migrations/004_inventory_kind_location_owner'),
    import('./migrations/005_item_category_returnable'), import('./migrations/006_equipment_units'),
    import('./migrations/007_location_active'), import('./migrations/008_job_workorder_fields'),
    import('./migrations/009_location_coords'), import('./migrations/010_app_config'),
    import('./migrations/011_taxonomy_types'), import('./migrations/012_product_classes_owner'),
    import('./migrations/013_hardening'), import('./migrations/014_role_permissions'),
    import('./migrations/015_team_managers'), import('./migrations/016_job_insurance'),
    import('./migrations/017_location_types_item_home'), import('./migrations/018_item_pack_size'),
    import('./migrations/019_repairs'), import('./migrations/020_location_has_shelves'),
    import('./migrations/021_taxonomy_dedup'), import('./migrations/022_role_color'),
    import('./migrations/023_repair_fields_parts'),
    import('./migrations/024_telemetry_buffer'),
    import('./migrations/025_notifications_and_approvals'),
    import('./migrations/026_drop_teams_manager_id'),
    import('./migrations/027_equipment_lifecycle'),
    import('./migrations/028_label_templates'),
    import('./migrations/029_taxonomy_fk'),
    import('./migrations/030_location_subtypes'),
    import('./migrations/031_repairs_status_fk'),
    import('./migrations/032_user_email'),
    import('./migrations/033_dashboards'),
    import('./migrations/034_chat'),
    import('./migrations/035_jobs_team_id'),
    import('./migrations/036_media_hub'),
    import('./migrations/037_test_accounts'),
    import('./migrations/038_equipment_type'),
    import('./migrations/039_message_edits'),
    import('./migrations/040_user_prefs'),
    import('./migrations/041_subteams'),
    import('./migrations/042_vehicles'),
    import('./migrations/043_locker_access'),
    import('./migrations/044_on_call'),
    import('./migrations/045_two_tanks'),
    import('./migrations/046_unit_access'),
    import('./migrations/047_flatten_and_dedupe'),
    import('./migrations/048_on_call_coverage'),
    import('./migrations/049_user_phone'),
    import('./migrations/050_vehicle_checkout_lock'),
    import('./migrations/051_job_assignments'),
    import('./migrations/052_media_audience'),
  ]);
  return m.map(x => x.migration as Migration).sort((a, b) => a.version - b.version);
}

async function runMigrations(database: SqlDb): Promise<void> {
  database.executeSync(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const versionRow = database.executeSync(`SELECT value FROM app_settings WHERE key = 'schema_version'`).rows[0] as { value: string } | undefined;
  const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;
  const pending = (await loadMigrations()).filter(mig => mig.version > currentVersion);
  if (pending.length === 0) { console.log(`[DB:web] schema v${currentVersion} ready`); return; }
  for (const mig of pending) {
    database.executeSync('BEGIN');
    try {
      mig.up(database);
      database.executeSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', ?)`, [String(mig.version)]);
      database.executeSync('COMMIT');
    } catch (err) {
      database.executeSync('ROLLBACK');
      throw new Error(`web migration v${mig.version} failed: ${(err as Error).message}`);
    }
  }
  await flush(); // persist freshly-migrated schema immediately
  console.log(`[DB:web] schema v${pending[pending.length - 1].version} ready`);
}

// ── shared helpers (identical to schema.ts) ──────────────────────────────────
export function rowsAs<T>(rows: unknown[]): T[] { return rows as unknown as T[]; }
type Bindable = string | number | null | Uint8Array;
export function toBindable(value: unknown): Bindable {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}
export function bindParams(params: readonly unknown[]): Bindable[] { return params.map(toBindable); }
