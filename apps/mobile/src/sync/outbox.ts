import { getDb } from '../db/schema';
import { generateUUID } from '../utils/uuid';
import { assertWritable } from '../db/maintenance';

// Max delivery attempts before an entry is considered "failed" and dropped from
// the active retry loop. Single source of truth (engine + outbox + indicator all
// read this) so a dead entry is classified consistently everywhere.
export const MAX_OUTBOX_ATTEMPTS = 5;

export type OutboxOperation = 'INSERT' | 'UPDATE' | 'DELETE' | 'ADJUST';

export interface OutboxEntry {
  id: string;
  operation: OutboxOperation;
  table_name: string;
  payload: Record<string, unknown>;
  created_at: string;
  attempts: number;
  last_error: string | null;
  synced_at: string | null;
}

export function appendOutbox(
  operation: OutboxOperation,
  table_name: string,
  payload: Record<string, unknown>
): void {
  assertWritable();
  const db = getDb();
  db.executeSync(
    `INSERT INTO outbox (id, operation, table_name, payload, created_at, attempts, last_error, synced_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)`,
    [generateUUID(), operation, table_name, JSON.stringify(payload), new Date().toISOString()]
  );
}

export function getPendingOutbox(limit = 50): OutboxEntry[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM outbox WHERE synced_at IS NULL ORDER BY created_at ASC LIMIT ?`,
    [limit]
  );
  return (result.rows as unknown as OutboxEntry[]).map(row => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  }));
}

export function markOutboxSynced(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  db.executeSync(
    `UPDATE outbox SET synced_at = ? WHERE id IN (${placeholders})`,
    [new Date().toISOString(), ...ids]
  );
}

export function incrementOutboxAttempt(id: string, error: string): void {
  const db = getDb();
  db.executeSync(
    `UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
    [error, id]
  );
}

// Permanently drop a single entry the server rejected for a reason retrying can
// never fix (an authorization denial). Unlike incrementOutboxAttempt this does
// not leave the row pending-but-dead — it's removed, so the sync indicator can't
// stick on a write that will never be accepted.
export function dropOutboxEntry(id: string): void {
  const db = getDb();
  db.executeSync(`DELETE FROM outbox WHERE id = ?`, [id]);
}

export function getPendingCount(): number {
  const db = getDb();
  const result = db.executeSync(
    `SELECT COUNT(*) as cnt FROM outbox WHERE synced_at IS NULL`
  );
  return ((result.rows[0] as { cnt: number } | undefined)?.cnt) ?? 0;
}

// Counts split by deliverability: `active` are still being retried (attempts <
// MAX), `failed` have exhausted retries and are NO LONGER sent — they're what
// silently pinned the "pending" indicator forever. Surfacing them separately
// lets the UI show a recoverable "failed" state instead of a stuck "pending".
export function getOutboxCounts(): { active: number; failed: number } {
  const db = getDb();
  const row = db.executeSync(
    `SELECT
       COALESCE(SUM(CASE WHEN attempts <  ? THEN 1 ELSE 0 END), 0) AS active,
       COALESCE(SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END), 0) AS failed
     FROM outbox WHERE synced_at IS NULL`,
    [MAX_OUTBOX_ATTEMPTS, MAX_OUTBOX_ATTEMPTS]
  ).rows[0] as { active: number; failed: number } | undefined;
  return { active: row?.active ?? 0, failed: row?.failed ?? 0 };
}

// Failed (retry-exhausted) entries, newest first, for diagnostic display.
export function getFailedOutbox(limit = 50): OutboxEntry[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM outbox
     WHERE synced_at IS NULL AND attempts >= ?
     ORDER BY created_at DESC LIMIT ?`,
    [MAX_OUTBOX_ATTEMPTS, limit]
  );
  return (result.rows as unknown as OutboxEntry[]).map(row => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  }));
}

// Re-arm every failed entry (attempts → 0) so the next sync cycle retries it.
// Use after the underlying cause is fixed (e.g. a migration deployed). Returns
// how many were reset.
export function retryFailedOutbox(): number {
  const db = getDb();
  const { failed } = getOutboxCounts();
  if (failed === 0) return 0;
  db.executeSync(
    `UPDATE outbox SET attempts = 0, last_error = NULL
     WHERE synced_at IS NULL AND attempts >= ?`,
    [MAX_OUTBOX_ATTEMPTS]
  );
  return failed;
}

// Permanently drop failed entries (give up on un-deliverable changes). Returns
// how many were discarded.
export function discardFailedOutbox(): number {
  const db = getDb();
  const { failed } = getOutboxCounts();
  if (failed === 0) return 0;
  db.executeSync(
    `DELETE FROM outbox WHERE synced_at IS NULL AND attempts >= ?`,
    [MAX_OUTBOX_ATTEMPTS]
  );
  return failed;
}
