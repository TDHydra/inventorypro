import { getDb } from './schema';
import { bumpTablesVersion } from '../sync/dataVersion';

let depth = 0;

// Tables touched by writes inside the currently open transaction. Non-null only
// while the outermost runInTransaction frame is active; the bump is deferred to
// COMMIT so listeners never observe a change that could still roll back, and a
// multi-write flow notifies once instead of once per statement.
let txTouchedTables: Set<string> | null = null;

/**
 * Record that a local write touched `table` so subscribed screens re-query
 * (see ../sync/dataVersion.ts). Inside a transaction the bump is deferred until
 * COMMIT (deduped across the whole flow) and discarded on ROLLBACK; outside a
 * transaction it fires immediately.
 */
export function queueTableBump(table: string): void {
  if (txTouchedTables) txTouchedTables.add(table);
  else bumpTablesVersion([table]);
}

/**
 * Runs `fn` inside a single SQLite transaction (BEGIN/COMMIT, ROLLBACK on throw)
 * so multi-statement write flows are atomic — either every write lands or none
 * do. Works on both op-sqlite (native) and the sql.js shim (web), which both
 * accept plain BEGIN/COMMIT/ROLLBACK via executeSync.
 *
 * Reentrant: a nested runInTransaction call joins the outer transaction instead
 * of issuing a second BEGIN (SQLite has no nested transactions), so the whole
 * outer flow still commits/rolls back as one unit. The original error is
 * re-thrown after rollback so callers can surface it to the user.
 */
export function runInTransaction<T>(fn: () => T): T {
  if (depth > 0) {
    // Already inside a transaction — just run; the outermost call owns commit
    // (and the deferred table bumps).
    depth++;
    try {
      return fn();
    } finally {
      depth--;
    }
  }

  const db = getDb();
  db.executeSync('BEGIN');
  depth = 1;
  txTouchedTables = new Set();
  let committed = false;
  try {
    const result = fn();
    db.executeSync('COMMIT');
    committed = true;
    return result;
  } catch (err) {
    try {
      db.executeSync('ROLLBACK');
    } catch {
      /* rollback best-effort — surface the ORIGINAL error below */
    }
    throw err;
  } finally {
    depth = 0;
    // Capture + clear BEFORE notifying: a listener that writes again must start
    // a fresh cycle, not re-enter this one.
    const touched = txTouchedTables;
    txTouchedTables = null;
    if (committed && touched && touched.size > 0) bumpTablesVersion(touched);
  }
}
