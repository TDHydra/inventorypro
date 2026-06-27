import { getDb } from '../db/schema';
import { generateUUID } from '../utils/uuid';
import { assertWritable } from '../db/maintenance';

export type OutboxOperation = 'INSERT' | 'UPDATE' | 'DELETE';

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

export function getPendingCount(): number {
  const db = getDb();
  const result = db.executeSync(
    `SELECT COUNT(*) as cnt FROM outbox WHERE synced_at IS NULL`
  );
  return ((result.rows[0] as { cnt: number } | undefined)?.cnt) ?? 0;
}
