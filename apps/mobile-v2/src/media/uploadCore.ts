// Station D2: ported from apps/mobile/src/media/uploadCore.ts (#31-D2).
// Platform-agnostic half of the media upload flow. The transport (streaming
// the bytes to the presigned URL) is platform-specific and lives in
// ./upload.ts (native, expo-file-system) / ./upload.web.ts (browser fetch);
// both share this request/insert logic so the /media contract stays identical.
//
// v2 changes: the DB insert moved to repos/media.ts (insertMediaRow there,
// through createRepository('media').mirror() — repos own all writes); this
// module keeps the same exported surface and generates the row id.
import { generateUUID } from '../utils/uuid';
import { getValidJwt } from '../auth/session';
import { insertMediaRow as repoInsertMediaRow } from '../repos/media';

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
  roomId?: string | null; // #173: job photo → rooms.id (job entity only)
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
export function insertMediaRow(input: UploadMediaInput, publicUrl: string): UploadedMedia {
  return repoInsertMediaRow({
    entityType: input.entityType,
    entityId: input.entityId,
    mediaType: input.mediaType,
    url: publicUrl,
    userId: input.userId,
    locationNote: input.locationNote,
    caption: input.caption,
    audience: input.audience,
    audienceUserIds: input.audienceUserIds,
    roomId: input.roomId,
  }, generateUUID());
}
