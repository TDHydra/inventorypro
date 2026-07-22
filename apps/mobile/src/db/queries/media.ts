import { getDb } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';

export interface MediaRecord {
  id: string;
  entity_type: string;
  entity_id: string;
  media_type: 'image' | 'video';
  url: string;
  thumbnail_url: string | null;
  caption: string | null;
  location_note: string | null;
  is_primary: number;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string | null;
}

export function getMediaForEntity(entityType: string, entityId: string): MediaRecord[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM media WHERE entity_type = ? AND entity_id = ? ORDER BY is_primary DESC, created_at DESC`,
    [entityType, entityId]
  );
  return result.rows as unknown as MediaRecord[];
}

export function getPrimaryMedia(entityType: string, entityId: string): MediaRecord | null {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM media WHERE entity_type = ? AND entity_id = ? ORDER BY is_primary DESC, created_at DESC LIMIT 1`,
    [entityType, entityId]
  );
  return (result.rows[0] as unknown as MediaRecord) ?? null;
}

// ── Media hub ────────────────────────────────────────────────────────────────

// The SQL builder is pure and lives in ./mediaHubQuery (DB-free so it runs
// under node --test); re-exported here for call-site convenience.
export { buildMediaHubQuery, type MediaHubFilter } from './mediaHubQuery';
import { buildMediaHubQuery as buildQuery, type MediaHubFilter as HubFilter } from './mediaHubQuery';

// A hub row: the media record plus display joins (job name/status when the
// media hangs off a job, uploader name always).
export interface MediaHubRow extends MediaRecord {
  job_name: string | null;
  job_status: string | null;
  uploader_name: string | null;
}

export function getMediaHubPage(
  filter: HubFilter,
  search: string,
  limit: number,
  offset: number,
): MediaHubRow[] {
  const db = getDb();
  const { sql, params } = buildQuery(filter, search, limit, offset);
  return db.executeSync(sql, params).rows as unknown as MediaHubRow[];
}

export function getMediaDetail(id: string): MediaHubRow | null {
  const db = getDb();
  const result = db.executeSync(
    `SELECT m.*, j.name AS job_name, j.status AS job_status, u.name AS uploader_name
     FROM media m
     LEFT JOIN jobs j ON m.entity_type = 'job' AND j.id = m.entity_id
     LEFT JOIN users u ON u.id = m.uploaded_by
     WHERE m.id = ?`,
    [id]
  );
  return (result.rows[0] as unknown as MediaHubRow) ?? null;
}

// Location notes already used on this job, recent first — so during a
// multi-upload the second "master bedroom" is one tap, not typed again.
export function getLocationNoteSuggestions(jobId: string): string[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT location_note, MAX(updated_at) AS last_used FROM media
     WHERE entity_type = 'job' AND entity_id = ? AND location_note IS NOT NULL AND TRIM(location_note) != ''
     GROUP BY location_note ORDER BY last_used DESC LIMIT 8`,
    [jobId]
  );
  return (result.rows as unknown as { location_note: string }[]).map(r => r.location_note);
}

// #148: Room/Area suggestions for pool quick-photos — the uploader's own past
// pool notes (job flow keeps the job-scoped variant above).
export function getPoolLocationNoteSuggestions(userId: string): string[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT location_note, MAX(updated_at) AS last_used FROM media
     WHERE entity_type = 'pool' AND uploaded_by = ? AND location_note IS NOT NULL AND TRIM(location_note) != ''
     GROUP BY location_note ORDER BY last_used DESC LIMIT 8`,
    [userId]
  );
  return (result.rows as unknown as { location_note: string }[]).map(r => r.location_note);
}

// ── Mutations (offline-first: local write + outbox; server re-authorizes) ────

function logMediaAction(action: 'media_updated' | 'media_deleted', mediaId: string, userId: string | null, note: string | null): void {
  appendLog({
    action,
    entity_type: 'media',
    entity_id: mediaId,
    user_id: userId,
    note,
    team_id: null, from_location_id: null, to_location_id: null,
    quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
  });
}

// Edit caption / location note. Gated client-side on edit_media (the sync push
// re-checks server-side). updated_at is set locally for immediate UI ordering;
// the server stamps its own NOW() authoritatively on apply.
export function updateMediaMeta(
  id: string,
  fields: { caption?: string | null; location_note?: string | null },
  userId: string | null,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (fields.caption !== undefined) { sets.push('caption = ?'); params.push(fields.caption); }
  if (fields.location_note !== undefined) { sets.push('location_note = ?'); params.push(fields.location_note); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(now, id);
  db.executeSync(`UPDATE media SET ${sets.join(', ')} WHERE id = ?`, params);
  appendOutbox('UPDATE', 'media', { id, ...fields });
  logMediaAction('media_updated', id, userId, fields.location_note ?? fields.caption ?? null);
}

// Move media to another job. Clears is_primary: the moved photo must not
// arrive as the target job's primary, and primary election is per-entity.
// The server restricts moves to EXISTING jobs (validateMediaWrite + existence
// check), so a stale local job id is rejected there, not silently applied.
export function moveMediaToJob(id: string, jobId: string, userId: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `UPDATE media SET entity_type = 'job', entity_id = ?, is_primary = 0, updated_at = ? WHERE id = ?`,
    [jobId, now, id]
  );
  appendOutbox('UPDATE', 'media', { id, entity_type: 'job', entity_id: jobId, is_primary: false });
  logMediaAction('media_updated', id, userId, 'moved to another job');
}

// Delete. Local row goes now (offline-first); the server's sync DELETE branch
// removes the MinIO object best-effort once the outbox entry lands.
export function deleteMedia(id: string, userId: string | null): void {
  const db = getDb();
  db.executeSync(`DELETE FROM media WHERE id = ?`, [id]);
  appendOutbox('DELETE', 'media', { id });
  logMediaAction('media_deleted', id, userId, null);
}

// Batch delete — same offline-first contract as deleteMedia, one outbox entry
// per id so the server processes each independently (permission re-check +
// object cleanup per row on apply).
export function deleteBulkMedia(ids: string[], userId: string | null): void {
  for (const id of ids) {
    deleteMedia(id, userId);
  }
}
