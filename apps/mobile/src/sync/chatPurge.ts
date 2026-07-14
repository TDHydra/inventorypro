import { getDb } from '../db/schema';
import { getValidJwt, getSavedUserId } from '../auth/session';
import { bumpDataVersion } from './dataVersion';
import { loadChatCache } from '../chat/store';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// Reconcile local chat tables against what the server is now willing to give this
// user (routes/sync.ts chatScopeSql). Mirrors teamPurge.ts: incremental /sync/pull
// is UPSERT-ONLY — when a user is REMOVED from a conversation, the scoped pull
// simply stops returning it and nothing tells the device to forget the rows. So a
// removed member keeps the full history until this runs.
//
// It deliberately does NOT call resetLocalDb(): that drops the OUTBOX, silently
// destroying un-pushed offline edits. Only the three chat tables are touched, and
// conversations still referenced by PENDING outbox rows are always kept — an
// offline-created conversation is invisible to the server until its outbox entry
// pushes, and deleting it here would orphan those queued writes.

function getFlag(key: string): string | null {
  const db = getDb();
  const row = db.executeSync(`SELECT value FROM app_settings WHERE key = ?`, [key]).rows[0] as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setFlag(key: string, value: string): void {
  getDb().executeSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`, [key, value]);
}

// Fetch every conversation id the server will give us, following its pagination.
// The endpoint is already chat-scoped server-side (participant conversations only).
async function fetchServerConversationIds(jwt: string): Promise<Set<string> | null> {
  const ids = new Set<string>();
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const res = await fetch(`${API_BASE}/sync/full?table=conversations&limit=${limit}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    // Any non-OK page means we do NOT know the authoritative set. Deleting on a
    // guess would wipe the user's conversations on a transient 500.
    if (!res.ok) return null;
    const body = (await res.json()) as { rows: Record<string, unknown>[]; hasMore: boolean };
    for (const row of body.rows) {
      const v = row.id;
      if (typeof v === 'string') ids.add(v);
    }
    if (!body.hasMore) break;
  }
  return ids;
}

// Conversation ids referenced by PENDING outbox rows — offline-created
// conversations (and offline messages/participant writes) that the server has
// never seen. These MUST survive the purge or the queued writes are orphaned.
function pendingOutboxConversationIds(): Set<string> {
  const db = getDb();
  const rows = db.executeSync(
    `SELECT table_name, payload FROM outbox
      WHERE synced_at IS NULL
        AND table_name IN ('conversations', 'conversation_participants', 'messages')`,
  ).rows as { table_name: string; payload: string }[];
  const ids = new Set<string>();
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      const cid = r.table_name === 'conversations' ? p.id : p.conversation_id;
      if (typeof cid === 'string') ids.add(cid);
    } catch { /* unparseable payload — keep-set stays smaller, never larger */ }
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

const LAST_RUN_KEY = 'chat_reconciled_at';
// Same throttle rationale as teamPurge: the sync engine calls this every 60s
// cycle, reconciling costs a paginated /sync/full, and removal converging within
// the hour is acceptable — the server scope is the enforcement of record.
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delete local chat rows for conversations the server no longer returns. Safe to
 * call on every sync (throttled internally to hourly). No-ops without a session.
 * Returns the number of rows removed, 0 if skipped, or -1 if the server set could
 * not be established (in which case nothing was deleted).
 */
export async function reconcileChat(): Promise<number> {
  const last = Number(getFlag(LAST_RUN_KEY) ?? 0);
  if (Number.isFinite(last) && Date.now() - last < RECONCILE_INTERVAL_MS) return 0;

  const jwt = await getValidJwt();
  if (!jwt) return -1;

  const serverIds = await fetchServerConversationIds(jwt);
  if (!serverIds) return -1;

  // Union with pending-outbox conversation ids so offline-created conversations
  // (not yet pushed, hence absent from the server set) survive.
  const keep = new Set(serverIds);
  for (const id of pendingOutboxConversationIds()) keep.add(id);

  let removed = deleteLocalRowsNotIn('messages', 'conversation_id', keep);
  removed += deleteLocalRowsNotIn('conversation_participants', 'conversation_id', keep);
  removed += deleteLocalRowsNotIn('conversations', 'id', keep);

  setFlag(LAST_RUN_KEY, String(Date.now()));

  if (removed > 0) {
    // Open screens re-query (useDataVersion) and the unread badge recomputes.
    bumpDataVersion();
    const userId = await getSavedUserId();
    loadChatCache(userId);
  }
  return removed;
}
