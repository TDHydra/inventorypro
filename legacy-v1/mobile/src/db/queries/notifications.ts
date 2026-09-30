import { getDb, rowsAs } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { generateUUID } from '../../utils/uuid';

// A synced notifications-inbox row (migration 025, mirrors API migration 032).
// `data` is a JSON string ({ screen, id } deep-link payload or null). Everything
// except `read_at` is server-owned — the client may only ever mark a row read
// (syncPolicy SENSITIVE_DENY on the API enforces this on the wire).
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

// Newest first; capped so a busy inbox never loads an unbounded list. The pull
// is already scoped to the caller server-side, so no user_id filter is needed
// (the local table only ever holds this device's rows).
export function listNotifications(limit = 200): NotificationRow[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
  return rowsAs<NotificationRow>(result.rows);
}

// Count of unread rows — drives the header bell badge.
export function countUnread(): number {
  const db = getDb();
  const result = db.executeSync(
    `SELECT COUNT(*) AS cnt FROM notifications WHERE read_at IS NULL`,
  );
  return (result.rows[0] as { cnt: number } | undefined)?.cnt ?? 0;
}

// Mark one row read: stamp read_at locally + queue the outbox UPDATE carrying
// ONLY { id, read_at } — read_at is the single client-writable column (the
// server rejects/strips any other field on a notifications UPDATE). Idempotent:
// a row already read is left untouched and no redundant outbox entry is queued.
export function markRead(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.executeSync(
    `SELECT read_at FROM notifications WHERE id = ?`,
    [id],
  );
  const row = existing.rows[0] as { read_at: string | null } | undefined;
  if (!row || row.read_at != null) return;
  db.executeSync(
    `UPDATE notifications SET read_at = ?, updated_at = ? WHERE id = ?`,
    [now, now, id],
  );
  appendOutbox('UPDATE', 'notifications', { id, read_at: now });
}

// Mark every unread row read (one outbox UPDATE per row, via markRead).
export function markAllRead(): void {
  const db = getDb();
  const result = db.executeSync(
    `SELECT id FROM notifications WHERE read_at IS NULL`,
  );
  for (const r of rowsAs<{ id: string }>(result.rows)) markRead(r.id);
}

// ── Approvals workflow (#5 client) ──────────────────────────────────────────
// A synced approval_requests row (migration 025, mirrors API migration 032).
// Two-way synced and org-wide: a requester INSERTs an `open` row; an approver
// UPDATEs status→approved|rejected. The server enforces who may decide (see
// syncPolicy / approval hooks) and forces requester_id = caller on INSERT.
export interface ApprovalRequestRow {
  id: string;
  requester_id: string;
  kind: string;
  title: string;
  detail: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  entity_type: string | null;
  entity_id: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateApprovalInput {
  // The current user's id — becomes requester_id (the server re-forces this to
  // the authenticated caller, so it is authoritative there, but we set it
  // locally so the row reads correctly offline before its first sync).
  requesterId: string;
  kind?: string;
  title: string;
  detail?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: string | null;
}

// Create a new `open` approval request: writes the local row + queues the outbox
// INSERT carrying the full row. Returns the created row.
export function createApprovalRequest(input: CreateApprovalInput): ApprovalRequestRow {
  const db = getDb();
  const now = new Date().toISOString();
  const row: ApprovalRequestRow = {
    id: generateUUID(),
    requester_id: input.requesterId,
    kind: input.kind ?? 'manual',
    title: input.title,
    detail: input.detail ?? null,
    status: 'open',
    decided_by: null,
    decided_at: null,
    decision_note: null,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    metadata: input.metadata ?? null,
    created_at: now,
    updated_at: now,
  };
  db.executeSync(
    `INSERT INTO approval_requests
       (id, requester_id, kind, title, detail, status, decided_by, decided_at,
        decision_note, entity_type, entity_id, metadata, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id, row.requester_id, row.kind, row.title, row.detail, row.status,
      row.decided_by, row.decided_at, row.decision_note, row.entity_type,
      row.entity_id, row.metadata, row.created_at, row.updated_at,
    ],
  );
  appendOutbox('INSERT', 'approval_requests', { ...row } as Record<string, unknown>);
  return row;
}

// Record an approve/reject decision: stamps status + decided_by/at + note
// locally and queues the outbox UPDATE (server re-validates the decider). The
// server bumps updated_at, so it is intentionally omitted from the outbox
// payload (matching markRead's minimal-diff pattern).
export function decideApproval(
  id: string,
  status: 'approved' | 'rejected',
  deciderId: string,
  note?: string | null,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `UPDATE approval_requests
       SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
     WHERE id = ?`,
    [status, deciderId, now, note ?? null, now, id],
  );
  appendOutbox('UPDATE', 'approval_requests', {
    id,
    status,
    decided_by: deciderId,
    decided_at: now,
    decision_note: note ?? null,
  });
}

// Every still-open request, newest first (approver worklist).
export function listOpenApprovals(): ApprovalRequestRow[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM approval_requests WHERE status = 'open' ORDER BY created_at DESC`,
  );
  return rowsAs<ApprovalRequestRow>(result.rows);
}

// Look up one request by id — used by the inbox to decide whether an
// `approval_request` notification still has an open, actionable row.
export function getApprovalRequestById(id: string): ApprovalRequestRow | undefined {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM approval_requests WHERE id = ?`,
    [id],
  );
  return rowsAs<ApprovalRequestRow>(result.rows)[0];
}
