// Station D2: ported from apps/mobile/src/db/queries/media.ts (+ the pure
// buildMediaHubQuery from db/queries/mediaHubQuery.ts, folded in per the plan
// — "media hub (simple repo query)"; the separate builder module is dead).
// Also absorbs isMediaUploadPending from the old sync/outbox.ts (a read-only
// outbox probe — the write path stays createRepository-only).
//
// v2 conventions applied:
//   - Mutations go through createRepository('media').mirror() with the OLD
//     app's exact outbox payload shapes: the media INSERT payload deliberately
//     omits updated_at (server stamps its own authoritative NOW() on apply)
//     and sends is_primary as a real boolean — repo.insert()'s auto-payload
//     would drift both, so mirror() it is.
//   - No self-logging (repos never appendLog; the old media.ts logged
//     media_updated/media_deleted itself). Callers (MediaDetailSheet, media
//     hub bulk delete) wrap runInTransaction + appendLog — same split as
//     PmContactPopup/clearSlot.
import { getDb, rowsAs } from '../db/schema';
import { createRepository, getAppSetting, setAppSetting } from '@invenpro/core';

const mediaRepo = createRepository('media');

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
  room_id: string | null;
  // #87 pool shares (null for non-pool media). audience_user_ids is a JSON
  // array string of user UUIDs when audience = 'users'.
  audience: 'everyone' | 'team' | 'users' | null;
  audience_user_ids: string | null;
}

export function getMediaForEntity(entityType: string, entityId: string): MediaRecord[] {
  return rowsAs<MediaRecord>(getDb().executeSync(
    `SELECT * FROM media WHERE entity_type = ? AND entity_id = ? ORDER BY is_primary DESC, created_at DESC`,
    [entityType, entityId],
  ).rows);
}

export function getPrimaryMedia(entityType: string, entityId: string): MediaRecord | null {
  return rowsAs<MediaRecord>(getDb().executeSync(
    `SELECT * FROM media WHERE entity_type = ? AND entity_id = ? ORDER BY is_primary DESC, created_at DESC LIMIT 1`,
    [entityType, entityId],
  ).rows)[0] ?? null;
}

// #87: deep-link lookup — is a pushed/notified media id already local? Used to
// decide between opening the sheet immediately vs. triggering a sync first.
export function getMediaById(id: string): MediaRecord | null {
  return rowsAs<MediaRecord>(getDb().executeSync(`SELECT * FROM media WHERE id = ?`, [id]).rows)[0] ?? null;
}

// Is this media row's upload still waiting to reach the server? Gates Share
// (the share-link mint reads the row from Postgres — a not-yet-pushed row
// 404s). Payload LIKE probe matches the `"id":"<uuid>"` shape appendOutbox
// serializes (insertMediaRow passes `id` first); denied = 0 because a denied
// write will never reach the server and must not hold the gate open forever.
export function isMediaUploadPending(mediaId: string): boolean {
  return getDb().executeSync(
    `SELECT 1 FROM outbox WHERE synced_at IS NULL AND denied = 0 AND table_name = 'media' AND payload LIKE ? LIMIT 1`,
    [`%"id":"${mediaId}"%`],
  ).rows.length > 0;
}

// ── Media hub ────────────────────────────────────────────────────────────────

// Every media metadata row is already on-device (the org-wide sync pulls the
// whole table), so the hub browses local SQLite; no server endpoint involved.
//   open       → job media for OPEN jobs only (the default working set)
//   all        → job media regardless of job status
//   everything → every entity's media (items, equipment, repairs, …) — the
//                caller gates this behind view_all_logs
//   shared     → #87/#148: pool-shared photos (entity_type='pool'). NOT gated
//                behind view_all_logs — a device only ever holds the pool rows
//                the server's media scope SQL already decided this user may
//                see, so it's personal inbox content, not an org-wide browse.
// Search is a LIKE over job name, location note, caption, and uploader name.
export type MediaHubFilter = 'open' | 'all' | 'everything' | 'shared';

// A hub row: the media record plus display joins (job name/status when the
// media hangs off a job, uploader name always).
export interface MediaHubRow extends MediaRecord {
  job_name: string | null;
  job_status: string | null;
  uploader_name: string | null;
}

export function getMediaHubPage(
  filter: MediaHubFilter,
  search: string,
  limit: number,
  offset: number,
): MediaHubRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter === 'open') {
    where.push(`m.entity_type = 'job'`, `j.status = 'open'`);
  } else if (filter === 'all') {
    where.push(`m.entity_type = 'job'`);
  } else if (filter === 'shared') {
    where.push(`m.entity_type = 'pool'`);
  }
  const q = search.trim();
  if (q) {
    where.push(`(j.name LIKE ? OR m.location_note LIKE ? OR m.caption LIKE ? OR u.name LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const sql =
    `SELECT m.*, j.name AS job_name, j.status AS job_status, u.name AS uploader_name
     FROM media m
     LEFT JOIN jobs j ON m.entity_type = 'job' AND j.id = m.entity_id
     LEFT JOIN users u ON u.id = m.uploaded_by` +
    (where.length ? `\n     WHERE ${where.join(' AND ')}` : '') +
    `\n     ORDER BY m.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return rowsAs<MediaHubRow>(getDb().executeSync(sql, params).rows);
}

export function getMediaDetail(id: string): MediaHubRow | null {
  return rowsAs<MediaHubRow>(getDb().executeSync(
    `SELECT m.*, j.name AS job_name, j.status AS job_status, u.name AS uploader_name
     FROM media m
     LEFT JOIN jobs j ON m.entity_type = 'job' AND j.id = m.entity_id
     LEFT JOIN users u ON u.id = m.uploaded_by
     WHERE m.id = ?`,
    [id],
  ).rows)[0] ?? null;
}

// Location notes already used on this job, recent first — so during a
// multi-upload the second "master bedroom" is one tap, not typed again.
export function getLocationNoteSuggestions(jobId: string): string[] {
  return rowsAs<{ location_note: string }>(getDb().executeSync(
    `SELECT location_note, MAX(updated_at) AS last_used FROM media
     WHERE entity_type = 'job' AND entity_id = ? AND location_note IS NOT NULL AND TRIM(location_note) != ''
     GROUP BY location_note ORDER BY last_used DESC LIMIT 8`,
    [jobId],
  ).rows).map(r => r.location_note);
}

// #148: Room/Area suggestions for pool quick-photos — the uploader's own past
// pool notes (job flow keeps the job-scoped variant above).
export function getPoolLocationNoteSuggestions(userId: string): string[] {
  return rowsAs<{ location_note: string }>(getDb().executeSync(
    `SELECT location_note, MAX(updated_at) AS last_used FROM media
     WHERE entity_type = 'pool' AND uploaded_by = ? AND location_note IS NOT NULL AND TRIM(location_note) != ''
     GROUP BY location_note ORDER BY last_used DESC LIMIT 8`,
    [userId],
  ).rows).map(r => r.location_note);
}

// Shared-media pill: pool photos other users shared TO this user. The server's
// pull scope SQL already restricts pool rows to the caller's audience, so
// every local pool row not uploaded by the user IS media shared with them.
export function getSharedPoolMediaCount(userId: string): number {
  const row = getDb().executeSync(
    `SELECT COUNT(*) AS n FROM media WHERE entity_type = 'pool' AND uploaded_by != ?`,
    [userId],
  ).rows[0] as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

// Seen-watermark for shared pool media (device-local app_settings, per-user
// key — never synced). Drives the media hub's "open on Shared when something
// new arrived" default. COALESCE(updated_at, created_at) so a photo re-shared
// later (audience change bumps updated_at server-side) counts as new.
const sharedSeenKey = (userId: string) => `shared_media_seen_at:${userId}`;

export function getUnseenSharedPoolMediaCount(userId: string): number {
  const since = getAppSetting(sharedSeenKey(userId)) ?? '';
  const row = getDb().executeSync(
    `SELECT COUNT(*) AS n FROM media
     WHERE entity_type = 'pool' AND uploaded_by != ?
       AND COALESCE(updated_at, created_at) > ?`,
    [userId, since],
  ).rows[0] as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function markSharedPoolMediaSeen(userId: string): void {
  setAppSetting(sharedSeenKey(userId), new Date().toISOString());
}

// ── Mutations (offline-first: local write + outbox; server re-authorizes) ────
// No self-logging here — callers append media_updated/media_deleted log rows.

export interface InsertMediaInput {
  entityType: string;
  entityId: string;
  mediaType: 'image' | 'video';
  url: string;
  userId: string;
  locationNote?: string | null;
  caption?: string | null; // #148: optional note
  audience?: 'team' | 'everyone' | 'users' | null; // #87: pool shares only
  audienceUserIds?: string[] | null; // #87: when audience === 'users'
  roomId?: string | null; // #173: job photo → rooms.id (job entity only)
}

// Local media row + outbox INSERT, after the bytes landed in MinIO.
// First image for an entity becomes its primary photo — read fresh from the DB
// (not a stale caller closure) so concurrent adds don't both claim it.
// updated_at is set locally for immediate ordering but deliberately NOT in the
// outbox payload: the server stamps its own authoritative NOW() on apply.
export function insertMediaRow(input: InsertMediaInput, id: string): { id: string; url: string } {
  const existing = getMediaForEntity(input.entityType, input.entityId);
  const isPrimary = existing.length === 0;
  const now = new Date().toISOString();
  const locationNote = input.locationNote ?? null;
  const caption = input.caption ?? null;
  // audience/audience_user_ids are pool-share-only (#87): a job/entity photo
  // always gets NULL here regardless of what the caller passed.
  const isPool = input.entityType === 'pool';
  const audience = isPool ? input.audience ?? null : null;
  const audienceUserIds = isPool && input.audience === 'users' && input.audienceUserIds?.length
    ? JSON.stringify(input.audienceUserIds) : null;
  // #173: room tagging is job-entity-only, same shape as the pool-only guard.
  const roomId = input.entityType === 'job' ? input.roomId ?? null : null;

  mediaRepo.mirror('INSERT', {
    id,
    entity_type: input.entityType,
    entity_id: input.entityId,
    media_type: input.mediaType,
    url: input.url,
    caption,
    location_note: locationNote,
    is_primary: isPrimary, // boolean — server column is BOOLEAN
    uploaded_by: input.userId,
    created_at: now,
    ...(audience ? { audience } : {}),
    ...(audienceUserIds ? { audience_user_ids: audienceUserIds } : {}),
    ...(roomId ? { room_id: roomId } : {}),
  }, () => {
    getDb().executeSync(
      `INSERT OR REPLACE INTO media (id, entity_type, entity_id, media_type, url, thumbnail_url, caption, location_note, is_primary, uploaded_by, created_at, updated_at, audience, audience_user_ids, room_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.entityType, input.entityId, input.mediaType, input.url, caption, locationNote, isPrimary ? 1 : 0, input.userId, now, now, audience, audienceUserIds, roomId],
    );
  });

  return { id, url: input.url };
}

// Edit caption / location note. Gated client-side on edit_media (the sync push
// re-checks server-side). updated_at is set locally for immediate UI ordering;
// the server stamps its own NOW() authoritatively on apply (not in payload).
export function updateMediaMeta(
  id: string,
  fields: { caption?: string | null; location_note?: string | null },
): void {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (fields.caption !== undefined) { sets.push('caption = ?'); params.push(fields.caption); }
  if (fields.location_note !== undefined) { sets.push('location_note = ?'); params.push(fields.location_note); }
  if (sets.length === 0) return;
  const now = new Date().toISOString();
  sets.push('updated_at = ?');
  params.push(now, id);
  mediaRepo.mirror('UPDATE', { id, ...fields }, () => {
    getDb().executeSync(`UPDATE media SET ${sets.join(', ')} WHERE id = ?`, params);
  });
}

// Move media to another job. Clears is_primary: the moved photo must not
// arrive as the target job's primary, and primary election is per-entity.
// The server restricts moves to EXISTING jobs, so a stale local job id is
// rejected there, not silently applied.
export function moveMediaToJob(id: string, jobId: string): void {
  const now = new Date().toISOString();
  mediaRepo.mirror('UPDATE', { id, entity_type: 'job', entity_id: jobId, is_primary: false }, () => {
    getDb().executeSync(
      `UPDATE media SET entity_type = 'job', entity_id = ?, is_primary = 0, updated_at = ? WHERE id = ?`,
      [jobId, now, id],
    );
  });
}

// Delete. Local row goes now (offline-first); the server's sync DELETE branch
// removes the MinIO object best-effort once the outbox entry lands.
export function deleteMedia(id: string): void {
  mediaRepo.mirror('DELETE', { id }, () => {
    getDb().executeSync(`DELETE FROM media WHERE id = ?`, [id]);
  });
}

// Batch delete — same offline-first contract as deleteMedia, one outbox entry
// per id so the server processes each independently (permission re-check +
// object cleanup per row on apply).
export function deleteBulkMedia(ids: string[]): void {
  for (const id of ids) deleteMedia(id);
}
