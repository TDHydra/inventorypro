// notifications-inbox domain — ported from apps/mobile/src/db/queries/
// notifications.ts's inbox half only (listNotifications/countUnread/
// markRead/markAllRead/NotificationRow). The SAME old file's approvals half
// (ApprovalRequestRow, createApprovalRequest, decideApproval,
// listOpenApprovals, getApprovalRequestById) was already ported to
// repos/approvals.ts in Station B3 — not re-ported here.
//
// `notifications` is a two-way synced, own-user-scoped table (manifest:
// scope 'own-user', fullDownload). Per the old migration's comment,
// everything except `read_at` is server-owned — the client's only write is
// marking a row read (the server's syncPolicy enforces this on the wire).
//
// markRead divergence: the old app's local UPDATE sets BOTH read_at and
// updated_at, but its outbox payload is a MINIMAL diff — `{ id, read_at }`
// WITHOUT updated_at ("the server stamps updated_at"). createRepository.update()
// would auto-touch updated_at into the payload when absent (see B3's
// decideApproval note for that harmless divergence), but here we match the
// old payload byte-for-byte instead by using the repo's `.mirror()` escape
// hatch with a hand-written local UPDATE (same SQL as the old app) and an
// exact `{ id, read_at }` outbox payload.
import { getDb, rowsAs } from '../db/schema';
import { createRepository } from '@invenpro/core';

const notificationsRepo = createRepository('notifications');

export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  data: string | null;
  read_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function listNotifications(limit = 200): NotificationRow[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
  return rowsAs<NotificationRow>(result.rows);
}

export function countUnread(): number {
  const db = getDb();
  const result = db.executeSync(
    `SELECT COUNT(*) AS cnt FROM notifications WHERE read_at IS NULL`,
  );
  return (result.rows[0] as { cnt: number } | undefined)?.cnt ?? 0;
}

export function markRead(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.executeSync(
    `SELECT read_at FROM notifications WHERE id = ?`,
    [id],
  );
  const row = existing.rows[0] as { read_at: string | null } | undefined;
  if (!row || row.read_at != null) return;
  notificationsRepo.mirror('UPDATE', { id, read_at: now }, () => {
    db.executeSync(
      `UPDATE notifications SET read_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
  });
}

export function markAllRead(): void {
  const db = getDb();
  const result = db.executeSync(
    `SELECT id FROM notifications WHERE read_at IS NULL`,
  );
  for (const r of rowsAs<{ id: string }>(result.rows)) markRead(r.id);
}
