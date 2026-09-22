// Incremental pull — manifest-driven. The per-table upsert SQL and value
// coercion that used to live here as a 35-entry hand-synced registry
// (apps/mobile pull.ts TABLE_UPSERT_SQL + rowToValues) now derive from the
// table manifest; parity with the old registry is proven by
// ../manifest/parity.test.ts.
import { getDb } from '../db/provider';
import { apiBase, getCoreConfig } from '../config';
import { bumpTablesVersion } from './dataVersion';
import { PULL_TABLES, upsertSql, rowToValues, getTableSpec } from '../manifest/derive';

// Precomputed per-table SQL — column ORDER inside the manifest is the wire
// contract, so this is stable for the life of the process.
const TABLE_UPSERT_SQL: Record<string, string> = Object.fromEntries(
  PULL_TABLES.map(spec => [spec.name, upsertSql(spec)]),
);

function getLastPulledAt(): string {
  const db = getDb();
  const result = db.executeSync(`SELECT value FROM app_settings WHERE key = 'last_pulled_at'`);
  return (result.rows[0] as { value: string } | undefined)?.value ?? new Date(0).toISOString();
}

function setLastPulledAt(ts: string): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_pulled_at', ?)`,
    [ts]
  );
}

/** Returns the set of tables a row was actually applied to (empty for a
 *  heartbeat pull) so the engine can hand it to the afterPull hooks. */
export async function pullChanges(): Promise<Set<string>> {
  const { auth } = getCoreConfig();
  const jwt = await auth.getValidJwt();
  if (!jwt) return new Set();

  const since = getLastPulledAt();
  const res = await fetch(`${apiBase()}/sync/pull?since=${encodeURIComponent(since)}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });

  if (res.status === 401) {
    // The server refused a JWT we thought was valid — it may be revoked ahead
    // of its exp (server-side logout). Settle it now (fire-and-forget; a dead
    // session raises the app logout via sessionExpiredBus).
    void auth.revalidateSession();
  }
  if (!res.ok) throw new Error(`Pull failed: ${res.status}`);

  const data = await res.json() as Record<string, { rows: Record<string, unknown>[] }>;
  const db = getDb();

  // Track WHICH tables actually had a row applied (#64) so per-table subscribers
  // (useTableVersion) only re-query when a table they render changed — a new
  // chat message no longer re-runs inventory search, the location tree, etc.
  // bumpTablesVersion also bumps the global counter, so screens still on
  // useDataVersion() refresh on any change. An empty-diff heartbeat pull adds
  // nothing to the set and bumps nothing.
  const changedTables = new Set<string>();

  // Suspend FK enforcement while applying the batch. Rows arrive in server
  // order, not dependency order, and locations.parent_id is self-referencing —
  // a child arriving before its parent in the same batch would fail the INSERT
  // and abort the whole cycle ("FOREIGN KEY constraint failed"), which reads as
  // sync being silently dead. The server owns FK integrity for synced rows.
  db.executeSync(`PRAGMA foreign_keys = OFF`);
  try {
    for (const [table, { rows }] of Object.entries(data)) {
      const sql = TABLE_UPSERT_SQL[table];
      const spec = getTableSpec(table);
      if (!sql || !spec || rows.length === 0) continue;

      for (const row of rows) {
        const values = rowToValues(spec, row);
        if (values.length > 0) {
          db.executeSync(sql, values as (string | number | null)[]);
          changedTables.add(table);
        }
      }
    }
  } finally {
    // Restore before any local write path runs — user edits stay FK-checked.
    db.executeSync(`PRAGMA foreign_keys = ON`);
  }

  setLastPulledAt(new Date().toISOString());

  if (changedTables.size > 0) bumpTablesVersion(changedTables);
  return changedTables;
}
