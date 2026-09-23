// Station D1: chat unread count, collapsed into createConfigCache
// (packages/core/src/cache/createConfigCache.ts) — its own header comment
// names "chat unread" as one of the old app's hand-rolled per-domain caches
// (src/chat/store.ts there) this factory exists to replace. This is the
// FIRST real call site of createConfigCache in the repo (grepped: the
// factory's own test/doc-comment were the only other references before this
// station) — Station C2's on-call "rotation fill" does NOT use it (plain
// function + useTableVersion), so there was no existing pattern to mirror
// beyond the factory's own test.
//
// createConfigCache's `load()` takes no arguments, but "my unread count"
// needs a user id — so the current user id is tracked in a tiny module-level
// variable (setChatCurrentUserId), kept in sync from app/_layout.tsx's
// session effect (mirrors how src/db/maintenance.ts's setMaintenanceRole is
// kept in sync from the same layout). Logging out clears it back to null,
// which reload() below just treats as "0 unread".
import { createConfigCache } from '@invenpro/core';
import { totalUnread } from '../repos/chat';

let currentUserId: string | null = null;

export const chatUnreadCache = createConfigCache<number>({
  name: 'chatUnread',
  // Unscoped by `tables` on purpose would mean "reload every pull cycle" —
  // instead we scope it to the tables that can change unread math, so a pull
  // that touches unrelated tables (inventory, jobs, ...) doesn't force a
  // wasted COUNT query.
  tables: ['messages', 'conversation_participants'],
  load: () => (currentUserId ? totalUnread(currentUserId) : 0),
  fallback: 0,
});

/**
 * Called from app/_layout.tsx whenever the signed-in user changes (login,
 * logout, switch account). Immediately reloads so the badge doesn't show a
 * stale count from the previous session for even one frame.
 */
export function setChatCurrentUserId(userId: string | null): void {
  currentUserId = userId;
  chatUnreadCache.reload();
}

/**
 * Local writes that change MY OWN unread count (marking a conversation read,
 * leaving a conversation) don't wait for the next sync pull — call this right
 * after them so the ChatBell badge updates immediately. Receiving a NEW
 * message from someone else only ever arrives via sync pull, which the
 * `afterPullHook` below already covers.
 */
export function reloadChatUnread(): void {
  chatUnreadCache.reload();
}
