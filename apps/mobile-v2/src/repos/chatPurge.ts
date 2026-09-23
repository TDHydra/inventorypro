// Chat purge/reconcile (afterPull hook) — ported from
// apps/mobile/src/sync/chatPurge.ts (function `reconcileChat`, module
// `chatPurge.ts` — the split file/function naming is kept 1:1 from the old
// app on purpose). Same rationale as repos/teams.ts's reconcileTeams (see
// that file's doc comment): incremental /sync/pull is UPSERT-ONLY and never
// deletes, so when a user is removed from a conversation (or a conversation/
// message is deleted server-side) nothing tells the device to forget the
// local rows. This MUST run on every pull cycle (throttled internally via
// app_settings), not just once — registered as a `tables`-unscoped
// afterPull hook in boot.ts, same as reconcileTeams.
//
// Deliberately scoped to only conversations/conversation_participants/
// messages — never resetLocalDb() (would drop the outbox and destroy
// unpushed offline edits).
import { getDb } from '../db/schema';
import { getAppSetting, setAppSetting, bumpTablesVersion } from '@invenpro/core';
import { getValidJwt } from '../auth/session';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const LAST_RUN_KEY = 'chat_reconciled_at';
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

async function fetchServerIds(table: string, idCol: string, jwt: string): Promise<Set<string> | null> {
  const ids = new Set<string>();
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const res = await fetch(`${API_BASE}/sync/full?table=${table}&limit=${limit}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    // Any non-OK response means we do NOT know the authoritative set. Deleting
    // on a guess would wipe the user's own conversations on a transient 500.
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

/**
 * Delete local chat rows (messages/conversation_participants/conversations)
 * the server no longer returns for this device. Safe to call on every pull
 * cycle (throttled internally). Returns the number of rows removed, 0 if
 * skipped, or -1 if the server set could not be established (nothing deleted
 * in that case).
 */
export async function reconcileChat(): Promise<number> {
  const last = Number(getAppSetting(LAST_RUN_KEY) ?? 0);
  if (Number.isFinite(last) && Date.now() - last < RECONCILE_INTERVAL_MS) return 0;

  const jwt = await getValidJwt();
  if (!jwt) return -1;

  const conversationIds = await fetchServerIds('conversations', 'id', jwt);
  if (!conversationIds) return -1;

  // messages/conversation_participants are keyed by conversation_id — scoping
  // both by the conversations keep-set mirrors the server's own predicate.
  let removed = deleteLocalRowsNotIn('messages', 'conversation_id', conversationIds);
  removed += deleteLocalRowsNotIn('conversation_participants', 'conversation_id', conversationIds);
  removed += deleteLocalRowsNotIn('conversations', 'id', conversationIds);

  setAppSetting(LAST_RUN_KEY, String(Date.now()));
  // Purged rows bypass queueTableBump (raw DELETEs, no repo/transaction) — bump
  // explicitly so any mounted useDbQuery(['messages',...]) screen re-reads and
  // the chat-unread cache (../chat/unread.ts) recomputes on its own afterPull
  // hook right after this one runs.
  if (removed > 0) bumpTablesVersion(['messages', 'conversation_participants', 'conversations']);
  return removed;
}
