import { getDb, rowsAs } from '../schema';
import { generateUUID } from '../../utils/uuid';

export interface LogEntry {
  id: string;
  user_id: string | null;
  team_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  from_location_id: string | null;
  to_location_id: string | null;
  quantity: number | null;
  unit: string | null;
  job_id: string | null;
  note: string | null;
  metadata: string | null; // JSON string
  device_id: string | null;
  created_at: string;
  synced_at: string | null;
}

export function appendLog(entry: Omit<LogEntry, 'id' | 'created_at' | 'synced_at'>): void {
  const db = getDb();
  const id = generateUUID();
  const created_at = new Date().toISOString();
  db.executeSync(
    `INSERT INTO activity_log
       (id, user_id, team_id, action, entity_type, entity_id,
        from_location_id, to_location_id, quantity, unit, job_id,
        note, metadata, device_id, created_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, entry.user_id, entry.team_id, entry.action, entry.entity_type,
     entry.entity_id, entry.from_location_id, entry.to_location_id,
     entry.quantity, entry.unit, entry.job_id, entry.note,
     entry.metadata, entry.device_id, created_at]
  );
}

export function getLogForUser(userId: string, limit = 50): LogEntry[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM activity_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit]
  );
  return rowsAs<LogEntry>(result.rows);
}

export function getLogForJob(jobId: string): LogEntry[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT al.*, u.name AS user_name
     FROM activity_log al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.job_id = ?
     ORDER BY al.created_at DESC`,
    [jobId]
  );
  return rowsAs<LogEntry>(result.rows);
}

export function getUnsyncedLogs(): LogEntry[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM activity_log WHERE synced_at IS NULL ORDER BY created_at ASC LIMIT 100`
  );
  return rowsAs<LogEntry>(result.rows);
}

export function markLogsSynced(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const now = new Date().toISOString();
  db.executeSync(
    `UPDATE activity_log SET synced_at = ? WHERE id IN (${placeholders})`,
    [now, ...ids]
  );
}
