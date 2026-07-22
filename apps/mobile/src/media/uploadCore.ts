import { getDb } from '../db/schema';
import { appendOutbox } from '../sync/outbox';
import { generateUUID } from '../utils/uuid';
import { getValidJwt } from '../auth/session';
import { getMediaForEntity } from '../db/queries/media';

// Platform-agnostic half of the media upload flow (#31-D2). The transport
// (streaming the bytes to the presigned URL) is platform-specific and lives in
// ./upload.ts (native, expo-file-system) / ./upload.web.ts (browser fetch);
// both share this request/insert logic so the /media contract stays identical.

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// Server rejects uploads whose declared content_length exceeds this; failing
// client-side saves the doomed round-trip.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Thrown before any network round-trip when the asset's size is known and over
// the cap — callers can branch on it for a "skipped" (vs "failed") message.
export class MediaTooLargeError extends Error {
  constructor() {
    super('That file is over 25 MB.');
    this.name = 'MediaTooLargeError';
  }
}

export interface UploadMediaInput {
  entityType: string;
  entityId: string;
  mediaType: 'image' | 'video';
  ext: string; // lowercase file extension, no dot
  uri?: string; // native file uri (required on native; web fallback when no file)
  file?: File; // web only: the picked File (preferred over uri)
  size?: number; // bytes when the caller already knows it; statted otherwise
  userId: string;
  locationNote?: string | null;
  caption?: string | null; // #148: optional note
  audience?: 'team' | 'everyone' | 'users' | null; // #87: pool shares only
  audienceUserIds?: string[] | null; // #87: when audience === 'users'
}

export interface UploadedMedia {
  id: string;
  url: string;
}

// Get a signed PUT URL. content_length (when the size is known) lets the server
// bind + cap the upload size at signing time (#31-D2).
export async function requestUploadUrl(
  input: UploadMediaInput,
  size: number | undefined,
): Promise<{ uploadUrl: string; publicUrl: string; contentType: string }> {
  // Uploads require online connectivity (presigned URL + direct PUT). The
  // /media/upload-url route is JWT-protected, so attach a fresh token.
  const jwt = await getValidJwt();
  if (!jwt) throw new Error('Connect to the server to upload media.');

  const urlRes = await fetch(`${API_BASE}/media/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      entity_type: input.entityType,
      entity_id: input.entityId,
      media_type: input.mediaType,
      file_extension: input.ext,
      ...(size !== undefined ? { content_length: size } : {}),
    }),
  });

  if (!urlRes.ok) throw new Error(`Could not get upload URL (${urlRes.status}).`);
  return await urlRes.json() as { uploadUrl: string; publicUrl: string; contentType: string };
}

// Local media row + outbox INSERT, after the bytes landed in MinIO.
// First image for an entity becomes its primary photo. Read fresh from the DB
// (not a stale caller closure) so concurrent adds don't both claim it — within
// a batch this also means only the first SUCCESSFUL upload can become primary,
// and only if the entity had none before.
export function insertMediaRow(input: UploadMediaInput, publicUrl: string): UploadedMedia {
  const existing = getMediaForEntity(input.entityType, input.entityId);
  const isPrimary = existing.length === 0;
  const id = generateUUID();
  const now = new Date().toISOString();
  const locationNote = input.locationNote ?? null;
  const caption = input.caption ?? null;
  // audience/audience_user_ids are pool-share-only (#87): a job/entity photo
  // always gets NULL here regardless of what the caller passed.
  const isPool = input.entityType === 'pool';
  const audience = isPool ? input.audience ?? null : null;
  const audienceUserIds = isPool && input.audience === 'users' && input.audienceUserIds?.length
    ? JSON.stringify(input.audienceUserIds) : null;

  const db = getDb();
  // updated_at is set locally for immediate ordering; the server stamps its
  // own authoritative NOW() on apply (so it's not in the outbox payload).
  db.executeSync(
    `INSERT OR REPLACE INTO media (id, entity_type, entity_id, media_type, url, thumbnail_url, caption, location_note, is_primary, uploaded_by, created_at, updated_at, audience, audience_user_ids)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.entityType, input.entityId, input.mediaType, publicUrl, caption, locationNote, isPrimary ? 1 : 0, input.userId, now, now, audience, audienceUserIds]
  );

  appendOutbox('INSERT', 'media', {
    id,
    entity_type: input.entityType,
    entity_id: input.entityId,
    media_type: input.mediaType,
    url: publicUrl,
    caption,
    location_note: locationNote,
    is_primary: isPrimary, // boolean — server column is BOOLEAN
    uploaded_by: input.userId,
    created_at: now,
    ...(audience ? { audience } : {}),
    ...(audienceUserIds ? { audience_user_ids: audienceUserIds } : {}),
  });

  return { id, url: publicUrl };
}
