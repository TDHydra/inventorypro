import { getDb } from './schema';

let depth = 0;

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
    // Already inside a transaction — just run; the outermost call owns commit.
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
  try {
    const result = fn();
    db.executeSync('COMMIT');
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
  }
}
