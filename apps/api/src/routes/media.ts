import { FastifyPluginAsync } from 'fastify';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';
import { requirePermission, userHasPermission } from '../lib/permissions';
import { MEDIA_ENTITY_TYPES } from '../lib/syncPolicy';
import { s3Public, BUCKET } from '../lib/s3';
import { KEY_RE, cleanupMediaObjects } from '../lib/mediaCleanup';

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
  content_length?: number;
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

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [(fastify as any).authenticate] };

  // POST /media/upload-url — get signed PUT URL for direct MinIO upload
  fastify.post<{ Body: UploadUrlBody }>('/upload-url', {
    preHandler: [(fastify as any).authenticate, requirePermission('upload_media')],
    schema: {
      body: {
        type: 'object',
        required: ['entity_type', 'entity_id', 'media_type', 'file_extension'],
        properties: {
          entity_type: { type: 'string' },
          entity_id: { type: 'string' },
          media_type: { type: 'string', enum: ['image', 'video'] },
          file_extension: { type: 'string' },
          // Optional: when the client declares a size we bind + cap it (25MB).
          // Omitted (e.g. current mobile client) → unbounded PUT, as before.
          content_length: { type: 'integer', minimum: 1, maximum: MAX_UPLOAD_BYTES },
        },
      },
    },
  }, async (request, reply) => {
    const { entity_type, entity_id, media_type, file_extension, content_length } = request.body;
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
    // Only validate the size when the client declared one (optional field).
    if (content_length !== undefined &&
        (!Number.isInteger(content_length) || content_length < 1 || content_length > MAX_UPLOAD_BYTES)) {
      return reply.status(400).send({ error: 'Invalid content_length' });
    }
    const key = `${entity_type}/${entity_id}/${uuid()}.${ext}`;
    // ContentType is bound into the presigned signature (device must echo it or
    // MinIO returns SignatureDoesNotMatch). When a content_length was declared we
    // also bind ContentLength, capping the PUT at exactly that size.
    const contentType = media_type === 'image' ? `image/${ext}` : `video/${ext}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
      ...(content_length !== undefined ? { ContentLength: content_length } : {}),
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

    // If setting as primary, unset existing primary for this entity
    if (is_primary) {
      await fastify.pg.query(
        `UPDATE media SET is_primary = false
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
      const { rows } = await fastify.pg.query(
        `SELECT * FROM media
         WHERE entity_type = $1 AND entity_id = $2
         ORDER BY is_primary DESC, created_at DESC`,
        [entityType, entityId]
      );
      return { media: rows };
    }
  );

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
