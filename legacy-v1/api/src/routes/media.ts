import { FastifyPluginAsync } from 'fastify';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';
import { requirePermission, userHasPermission } from '../lib/permissions';
import { MEDIA_ENTITY_TYPES } from '../lib/syncPolicy';
import { s3Public, BUCKET } from '../lib/s3';
import { KEY_RE, cleanupMediaObjects, deriveKey } from '../lib/mediaCleanup';
import { canSeeAllTeams, resolveCaller, teamScopeSql } from '../lib/scoping';
import { overLimit } from '../lib/rateLimit';

// #180 v1: external share (Android share sheet) hands the OS a LINK, not a
// file — RN core Share.share({ message: url }) only takes text. File sharing
// (expo-sharing, attaching the actual bytes) is deferred to the next native
// rebuild since expo-sharing is a native module and would break hotload.
//
// Normal presigned GETs (see /upload-url below) expire in 5 minutes — too
// short for a link dropped into Messages/WhatsApp/email and opened later.
// SigV4 presigned URLs cap X-Amz-Expires at 7 days (604800s) when signed with
// long-lived static credentials (ours, via s3Public) — MinIO enforces the same
// AWS ceiling — so 7 days is both the practical and the protocol maximum.
const SHARE_LINK_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

// MEDIA_ENTITY_TYPES lives in lib/syncPolicy.ts now — media may only attach to
// OPERATIONAL entities, never users / role_settings / app_config / teams (an
// IDOR sink). The sync push path enforces the same allowlist via
// validateMediaWrite. Keep in sync with the entityType values MediaGallery passes.

// File extension: short alphanumeric only — blocks path traversal, NUL bytes, and
// content-type injection (e.g. "jpg\0.txt", "../x", "jpg; charset=..").
const EXT_RE = /^[a-z0-9]{2,5}$/;
// Presigned PUT is otherwise unbounded — cap the declared upload size (25MB).
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface UploadUrlBody {
  entity_type: string;
  entity_id: string;
  media_type: 'image' | 'video';
  file_extension: string;
  content_length: number; // M4: required — see /upload-url schema
}

interface SaveMediaBody {
  entity_type: string;
  entity_id: string;
  media_type: 'image' | 'video';
  key: string;
  thumbnail_url?: string;
  caption?: string;
  is_primary?: boolean;
}

// #29-H: message attachments are conversation-private. Any media access keyed
// to a message — presigning an upload, saving the row, listing — must come from
// a participant of that message's conversation, or a caller could attach to /
// read attachments of chats they cannot see (the sync pull path enforces the
// same boundary via mediaScopeSql). Fails closed: a missing message or a
// malformed uuid (the cast throws) both come back as "not a participant".
async function callerInMessageConversation(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  messageId: string,
  callerId: string,
): Promise<boolean> {
  try {
    const { rows } = await pg.query(
      `SELECT 1 FROM messages m
         JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id
        WHERE m.id = $1 AND cp.user_id = $2`,
      [messageId, callerId],
    );
    return !!rows[0];
  } catch {
    return false;
  }
}

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [(fastify as any).authenticate] };

  // POST /media/upload-url — get signed PUT URL for direct MinIO upload
  fastify.post<{ Body: UploadUrlBody }>('/upload-url', {
    preHandler: [(fastify as any).authenticate, requirePermission('upload_media')],
    schema: {
      body: {
        type: 'object',
        required: ['entity_type', 'entity_id', 'media_type', 'file_extension', 'content_length'],
        properties: {
          entity_type: { type: 'string' },
          entity_id: { type: 'string' },
          media_type: { type: 'string', enum: ['image', 'video'] },
          file_extension: { type: 'string' },
          // M4 (2026-08-09 audit): now REQUIRED. A presigned PUT can only be
          // size-capped by binding an exact ContentLength into the signature, so
          // the client must declare the size — omitting it previously left the
          // PUT unbounded (a 60MB upload succeeded in the repro). Bound 1..25MB.
          content_length: { type: 'integer', minimum: 1, maximum: MAX_UPLOAD_BYTES },
        },
      },
    },
  }, async (request, reply) => {
    const { entity_type, entity_id, media_type, file_extension, content_length } = request.body;
    // M4: per-user media-upload throttle (in addition to the global mutation
    // limiter) — 60 presign requests / minute / user. In-memory, single-container
    // (same caveat as lib/rateLimit); a DoS-volume guard, not UX friction.
    const throttleId = (request.user as { sub: string }).sub;
    if (overLimit(`media-upload:${throttleId}`, 60)) {
      return reply.status(429).send({ error: 'Too many upload requests. Try again in a minute.' });
    }
    const ext = file_extension.toLowerCase();
    if (!MEDIA_ENTITY_TYPES.has(entity_type)) {
      return reply.status(400).send({ error: 'Invalid entity_type' });
    }
    if (!EXT_RE.test(ext)) {
      return reply.status(400).send({ error: 'Invalid file_extension' });
    }
    if (!entity_id || entity_id.length > 64 || /[^a-zA-Z0-9_-]/.test(entity_id)) {
      return reply.status(400).send({ error: 'Invalid entity_id' });
    }
    if (entity_type === 'message') {
      const callerId = (request.user as { sub: string }).sub;
      if (!(await callerInMessageConversation(fastify.pg, entity_id, callerId))) {
        return reply.status(403).send({ error: 'Forbidden: not a participant of this conversation' });
      }
    }
    // Defensive re-check (the schema already bounds it, but never presign an
    // unbounded/oversized PUT).
    if (!Number.isInteger(content_length) || content_length < 1 || content_length > MAX_UPLOAD_BYTES) {
      return reply.status(400).send({ error: 'Invalid content_length' });
    }
    const key = `${entity_type}/${entity_id}/${uuid()}.${ext}`;
    // ContentType is bound into the presigned signature (device must echo it or
    // MinIO returns SignatureDoesNotMatch). ContentLength is now always bound,
    // capping the PUT at exactly the declared size.
    const contentType = media_type === 'image' ? `image/${ext}` : `video/${ext}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: content_length,
    });

    const uploadUrl = await getSignedUrl(s3Public, command, { expiresIn: 300 });
    const publicUrl = `${process.env.PUBLIC_MEDIA_URL ?? 'https://localhost/media'}/${key}`;

    return { uploadUrl, key, publicUrl, contentType };
  });

  // POST /media — save media record after successful upload
  fastify.post<{ Body: SaveMediaBody }>('/', {
    preHandler: [(fastify as any).authenticate, requirePermission('upload_media')],
    schema: {
      body: {
        type: 'object',
        required: ['entity_type', 'entity_id', 'media_type', 'key'],
        properties: {
          entity_type: { type: 'string' },
          entity_id: { type: 'string' },
          media_type: { type: 'string' },
          key: { type: 'string' },
          thumbnail_url: { type: 'string' },
          caption: { type: 'string' },
          is_primary: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { entity_type, entity_id, media_type, key, thumbnail_url, caption, is_primary = false } = request.body;
    const userId = (request.user as { sub: string }).sub;
    if (!MEDIA_ENTITY_TYPES.has(entity_type)) {
      return reply.status(400).send({ error: 'Invalid entity_type' });
    }
    if (entity_type === 'message' && !(await callerInMessageConversation(fastify.pg, entity_id, userId))) {
      return reply.status(403).send({ error: 'Forbidden: not a participant of this conversation' });
    }
    // Bind the save to a key WE generated in /upload-url — never trust a
    // client-supplied URL (that was an SSRF/DB-pollution sink: a client could
    // point `url` anywhere and we'd store + serve it as this entity's media).
    if (!KEY_RE.test(key) || !key.startsWith(`${entity_type}/${entity_id}/`)) {
      return reply.status(400).send({ error: 'Invalid media key' });
    }
    const url = `${process.env.PUBLIC_MEDIA_URL ?? 'https://localhost/media'}/${key}`;

    // thumbnail_url gets the same treatment as `key`: it must be a server-issued
    // object key (from /upload-url) anchored to this entity, never an opaque
    // client URL — otherwise a forged thumbnail_url is both unvalidated and, on
    // delete, orphaned (the old DELETE cleanup only ever looked at `url`).
    // Absent/null stays null.
    let thumbnailUrl: string | null = null;
    if (thumbnail_url) {
      if (!KEY_RE.test(thumbnail_url) || !thumbnail_url.startsWith(`${entity_type}/${entity_id}/`)) {
        return reply.status(400).send({ error: 'Invalid thumbnail key' });
      }
      thumbnailUrl = `${process.env.PUBLIC_MEDIA_URL ?? 'https://localhost/media'}/${thumbnail_url}`;
    }

    // If setting as primary, unset existing primary for this entity. This route
    // takes an EXPLICIT is_primary from the caller (unlike the sync path's
    // automatic first-photo election, where the first claim wins), so the new row
    // takes over. updated_at must be bumped or the demoted row is invisible to
    // incremental pull (WHERE updated_at > since) and other devices keep the old
    // star forever — see lib/mediaPrimary.ts and migration 050.
    if (is_primary) {
      await fastify.pg.query(
        `UPDATE media SET is_primary = false, updated_at = NOW()
         WHERE entity_type = $1 AND entity_id = $2 AND is_primary = true`,
        [entity_type, entity_id]
      );
    }

    const { rows } = await fastify.pg.query(
      `INSERT INTO media (entity_type, entity_id, media_type, url, thumbnail_url, caption, is_primary, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [entity_type, entity_id, media_type, url, thumbnailUrl, caption ?? null, is_primary, userId]
    );
    return reply.status(201).send(rows[0]);
  });

  // GET /media/:entityType/:entityId — list media for an entity
  fastify.get<{ Params: { entityType: string; entityId: string } }>(
    '/:entityType/:entityId', {
      ...auth,
      schema: {
        params: {
          type: 'object',
          required: ['entityType', 'entityId'],
          properties: {
            // Enum bound to the same allowlist the handler enforces below.
            entityType: { type: 'string', enum: [...MEDIA_ENTITY_TYPES] },
            entityId: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    }, async (request, reply) => {
      const { entityType, entityId } = request.params;
      if (!MEDIA_ENTITY_TYPES.has(entityType)) {
        return reply.status(400).send({ error: 'Invalid entity_type' });
      }
      // Reads of message attachments are participant-gated too — the sync pull
      // scopes them (mediaScopeSql); this REST list must not bypass that.
      if (entityType === 'message') {
        const callerId = (request.user as { sub: string }).sub;
        if (!(await callerInMessageConversation(fastify.pg, entityId, callerId))) {
          return reply.status(403).send({ error: 'Forbidden: not a participant of this conversation' });
        }
      }
      // #87: pool shares are keyed to the UPLOADER's user id (discoverable via
      // the public /auth/roster), so an unscoped list would leak any user's pool
      // to any authenticated caller. REST is uploader-only; recipients get their
      // pool rows through the scoped sync pull (mediaScopeSql), never this route.
      if (entityType === 'pool') {
        const callerId = (request.user as { sub: string }).sub;
        if (entityId !== callerId) {
          return reply.status(403).send({ error: 'Forbidden: pool media is uploader-only via REST' });
        }
      }
      // H7 (2026-08-09 audit): job media follows the parent job's team scope —
      // the sync pull scopes `jobs` by team, so this REST read must too or a
      // caller who knows a job id reads another team's damage photos. Other
      // entity types (item/location/repair/equipment_unit/service_record) map
      // to sync tables that are org-wide readable by design, so their media
      // stays unscoped here — consistent with the sync model.
      if (entityType === 'job') {
        const callerId = (request.user as { sub: string }).sub;
        const caller = await resolveCaller(fastify.pg, callerId);
        // Fail CLOSED: an unresolvable caller is scoped, never handed the media.
        if (!caller || !canSeeAllTeams(caller)) {
          const scope = teamScopeSql('jobs', '$2');
          const { rows: j } = await fastify.pg.query(
            `SELECT 1 FROM jobs WHERE id = $1 AND ${scope}`,
            [entityId, callerId]
          );
          if (!j[0]) {
            return reply.status(403).send({ error: 'Forbidden: job not in your teams' });
          }
        }
      }
      const { rows } = await fastify.pg.query(
        `SELECT * FROM media
         WHERE entity_type = $1 AND entity_id = $2
         ORDER BY is_primary DESC, created_at DESC`,
        [entityType, entityId]
      );
      return { media: rows };
    }
  );

  // POST /media/:id/share-link — mint a longer-lived presigned GET URL for
  // external sharing (#180 v1: mobile hands this straight to Share.share()).
  // Message attachments stay conversation-private. Pool shares mirror the sync
  // pull's audience scope (uploader / everyone / team / users list) — anyone
  // who can see the photo in their media hub may share it externally; the
  // uploader-only rule stays on the LIST route above, which takes a
  // discoverable user id rather than an unguessable media id.
  fastify.post<{ Params: { id: string } }>('/:id/share-link', {
    ...auth,
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
    },
  }, async (request, reply) => {
    const callerId = (request.user as { sub: string }).sub;

    const { rows } = await fastify.pg.query(
      `SELECT * FROM media WHERE id = $1`,
      [request.params.id]
    );
    const media = rows[0] as {
      id: string; url: string; entity_type: string; entity_id: string;
      uploaded_by: string | null; audience: string | null; audience_user_ids: string | null;
    } | undefined;
    if (!media) return reply.status(404).send({ error: 'Not found' });

    if (media.entity_type === 'message') {
      if (!(await callerInMessageConversation(fastify.pg, media.entity_id, callerId))) {
        return reply.status(403).send({ error: 'Forbidden: not a participant of this conversation' });
      }
    }
    if (media.entity_type === 'pool') {
      const visible =
        media.uploaded_by === callerId ||
        media.audience === 'everyone' ||
        (media.audience === 'users'
          && (media.audience_user_ids ?? '').toLowerCase().includes(callerId.toLowerCase())) ||
        (media.audience === 'team'
          && (await fastify.pg.query(
            `SELECT 1 FROM team_members
             WHERE user_id = $1
               AND team_id IN (SELECT team_id FROM team_members WHERE user_id = $2)`,
            [media.uploaded_by, callerId],
          )).rows.length > 0);
      if (!visible) {
        return reply.status(403).send({ error: "Forbidden: not in this pool share's audience" });
      }
    }

    const key = deriveKey(media.url);
    if (!key) return reply.status(500).send({ error: 'Media object key could not be resolved' });

    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const shareUrl = await getSignedUrl(s3Public, command, { expiresIn: SHARE_LINK_EXPIRY_SECONDS });
    return { shareUrl, expiresInSeconds: SHARE_LINK_EXPIRY_SECONDS };
  });

  // DELETE /media/:id
  fastify.delete<{ Params: { id: string } }>('/:id', {
    ...auth,
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const { rows } = await fastify.pg.query(
      `SELECT * FROM media WHERE id = $1`,
      [request.params.id]
    );
    const media = rows[0] as { id: string; url: string; thumbnail_url: string | null; uploaded_by: string; entity_type: string; entity_id: string } | undefined;
    if (!media) return reply.status(404).send({ error: 'Not found' });

    // delete_media gates deletion — same permission the sync-push DELETE path
    // requires (syncPolicy OPERATION_PERM), so REST and sync agree. Resolved
    // through the permission system so role/user overrides apply. This replaced
    // the old uploader-or-system_settings rule when media became a real
    // permission family; no client calls this route today.
    const { rows: userRows } = await fastify.pg.query(
      `SELECT u.role, u.permission_overrides, rs.permission_overrides AS role_overrides
         FROM users u LEFT JOIN role_settings rs ON rs.role = u.role
        WHERE u.id = $1`, [userId]
    );
    const u = userRows[0] as { role: string; permission_overrides: Record<string, boolean> | null; role_overrides: Record<string, boolean> | null } | undefined;
    if (!u || !userHasPermission(u.role, u.permission_overrides, 'delete_media', u.role_overrides)) {
      return reply.status(403).send({ error: 'Forbidden: requires delete_media' });
    }

    // Object cleanup is shared with the sync-path delete (lib/mediaCleanup.ts):
    // move-tolerant key validation + table-wide refcount, best-effort. The DB
    // row is deleted regardless — a junk/legacy row with an unresolvable URL
    // must still be removable (the old inline version 400'd and stranded it).
    await fastify.pg.query(`DELETE FROM media WHERE id = $1`, [request.params.id]);
    await cleanupMediaObjects(fastify.pg, { id: media.id, url: media.url, thumbnail_url: media.thumbnail_url });
    return { deleted: true };
  });
};

export default routes;
