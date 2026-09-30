import { getDb } from '../db/schema';
import { getValidJwt } from '../auth/session';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// Reconcile the device's local `teams` / `team_members` against what the server is
// now willing to give this user (API 043 + routes/sync.ts teamScopeSql).
//
// WHY THIS EXISTS. Incremental /sync/pull is UPSERT-ONLY — it never deletes. Two
// consequences, and the second is permanent:
//
//  1. Before scoping, every device downloaded every team's roster and its
//     team_permission_overrides. Scoping the server does not retract those rows.
//     Migration 035 sets `teams_purge_pending` so this runs once to clean them out.
//
//  2. Ongoing: when a user is REMOVED from a team, the scoped pull simply stops
//     returning it. Nothing tells the device to forget it. So this must run on
//     every sync, not just once — a one-shot purge fixes today's leak and leaves a
//     permanent revocation hole.
//
// It deliberately does NOT call resetLocalDb(): that drops the OUTBOX, silently
// destroying un-pushed offline edits. Only these two tables are touched.

const PURGE_FLAG = 'teams_purge_pending';

function getFlag(key: string): string | null {
  const db = getDb();
  const row = db.executeSync(`SELECT value FROM app_settings WHERE key = ?`, [key]).rows[0] as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function clearFlag(key: string): void {
  getDb().executeSync(`DELETE FROM app_settings WHERE key = ?`, [key]);
}

function setFlag(key: string, value: string): void {
  getDb().executeSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`, [key, value]);
}

export function isTeamPurgePending(): boolean {
  return getFlag(PURGE_FLAG) === '1';
}

// Fetch every id the server will give us for a table, following its pagination.
async function fetchServerIds(table: string, idCol: string, jwt: string): Promise<Set<string> | null> {
  const ids = new Set<string>();
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const res = await fetch(`${API_BASE}/sync/full?table=${table}&limit=${limit}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    // Any non-OK response means we do NOT know the authoritative set. Deleting on a
    // guess would wipe the user's own teams on a transient 500.
    if (!res.ok) return null;
    const body = (await res.json()) as { rows: Record<string, unknown>[]; hasMore: boolean };
    for (const row of body.rows) {
      const v = row[idCol];
      if (typeof v === 'string') ids.add(v);
    }
    if (!body.hasMore) break;
  }
  return ids;
}

function deleteLocalRowsNotIn(table: string, idCol: string, keep: Set<string>): number {
  const db = getDb();
  const local = db.executeSync(`SELECT DISTINCT ${idCol} AS id FROM ${table}`).rows as { id: string }[];
  const stale = local.map(r => r.id).filter(id => !keep.has(id));
  for (const id of stale) {
    db.executeSync(`DELETE FROM ${table} WHERE ${idCol} = ?`, [id]);
  }
  return stale.length;
}

const LAST_RUN_KEY = 'teams_reconciled_at';
// The sync engine calls this every 60s cycle. Reconciling costs two paginated
// /sync/full requests, so throttle it — except when the one-time purge is pending,
// which must run at the first opportunity. Revocation converging within the hour is
// acceptable; the server is the enforcement of record either way.
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delete local team rows the server no longer returns. Safe to call on every sync
 * (throttled internally). No-ops without a session. Returns the number of rows
 * removed, 0 if skipped, or -1 if the server set could not be established (in which
 * case nothing was deleted).
 */
export async function reconcileTeams(): Promise<number> {
  const pending = isTeamPurgePending();
  if (!pending) {
    const last = Number(getFlag(LAST_RUN_KEY) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < RECONCILE_INTERVAL_MS) return 0;
  }

  const jwt = await getValidJwt();
  if (!jwt) return -1;

  const teamIds = await fetchServerIds('teams', 'id', jwt);
  if (!teamIds) return -1;

  // team_members is keyed (team_id, user_id). Scoping it by team_id is exactly the
  // server's own predicate: a device keeps the full roster of teams it may see, and
  // nothing for teams it may not.
  let removed = deleteLocalRowsNotIn('team_members', 'team_id', teamIds);
  removed += deleteLocalRowsNotIn('teams', 'id', teamIds);

  // Only on success — a failed fetch returned above without deleting, so the flag
  // survives and the purge retries on the next sync.
  if (pending) clearFlag(PURGE_FLAG);
  setFlag(LAST_RUN_KEY, String(Date.now()));
  return removed;
}
