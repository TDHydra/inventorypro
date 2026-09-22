// Web DB bootstrap: sql.js wrapped to core's SqlDb surface, persisted as an
// encrypted IndexedDB snapshot (webPersistence/webCrypto, carried verbatim
// from the old app). Migrations come from the SAME shared index the native
// schema.ts uses — no twin migration array.
import initSqlJs, { type Database } from 'sql.js';
import { setDbProvider, type SqlDb } from '@invenpro/core';
import { loadDbSnapshot, saveDbSnapshot, clearDbSnapshot } from './webPersistence';
import { runMigrations } from './migrations';

export { bindParams, toBindable } from '@invenpro/core';

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
  runMigrations(wrapped);
  await flush(); // persist freshly-migrated schema immediately
  setDbProvider(getDb);
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

export function rowsAs<T>(rows: unknown[]): T[] {
  return rows as unknown as T[];
}
