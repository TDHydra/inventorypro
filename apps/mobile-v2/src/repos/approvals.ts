// approval_requests domain — ported from apps/mobile/src/db/queries/
// notifications.ts's approvals half (the notifications-inbox half —
// listNotifications/countUnread/markRead/markAllRead — is OUT OF SCOPE this
// station; no standalone notifications inbox is being ported, see
// docs/REBUILD-NOTES.md Wave B section).
//
// A synced approval_requests row: two-way synced, org-wide (fullDownload —
// no `scope` restriction in the manifest). A requester INSERTs an `open` row;
// an approver UPDATEs status→approved|rejected. The server enforces WHO may
// decide and re-forces requester_id = caller on INSERT.
//
// Routed through createRepository('approval_requests') (insert()/update())
// rather than the old app's hand-rolled write+appendOutbox pair — this is a
// straight repo-ification, same class as B1/B2's other ports. ONE small,
// harmless divergence: the old app's decideApproval deliberately OMITTED
// updated_at from its outbox UPDATE payload ("the server bumps updated_at").
// createRepository.update() always auto-touches updated_at when the caller
// doesn't supply it (touchTimestamps), so this port's outbox payload DOES
// carry a client updated_at. That's harmless — the server remains
// authoritative for the column either way — but is noted here since it's a
// deliberate departure from the byte-for-byte old payload shape.
import { getDb, rowsAs } from '../db/schema';
import { createRepository } from '@invenpro/core';
import { generateUUID } from '../utils/uuid';

const approvalsRepo = createRepository('approval_requests');

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
  // the authenticated caller, so it is authoritative there, but it's set
  // locally so the row reads correctly offline before its first sync).
  requesterId: string;
  kind?: string;
  title: string;
  detail?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: string | null;
}

/** Create a new `open` approval request. Local INSERT OR REPLACE + outbox INSERT, via the repo. */
export function createApprovalRequest(input: CreateApprovalInput): ApprovalRequestRow {
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
  approvalsRepo.insert({ ...row });
  return row;
}

/**
 * Record an approve/reject decision: stamps status + decided_by/at + note
 * locally and queues the outbox UPDATE (server re-validates the decider).
 * See the header comment for the updated_at divergence from the old payload.
 */
export function decideApproval(
  id: string,
  status: 'approved' | 'rejected',
  deciderId: string,
  note?: string | null,
): void {
  const now = new Date().toISOString();
  approvalsRepo.update({
    id,
    status,
    decided_by: deciderId,
    decided_at: now,
    decision_note: note ?? null,
  });
}

/** Every still-open request, newest first (approver worklist). */
export function listOpenApprovals(): ApprovalRequestRow[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM approval_requests WHERE status = 'open' ORDER BY created_at DESC`,
  );
  return rowsAs<ApprovalRequestRow>(result.rows);
}

/** Look up one request by id. */
export function getApprovalRequestById(id: string): ApprovalRequestRow | undefined {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM approval_requests WHERE id = ?`,
    [id],
  );
  return rowsAs<ApprovalRequestRow>(result.rows)[0];
}
