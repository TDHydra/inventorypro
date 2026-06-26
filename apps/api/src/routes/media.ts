import { FastifyPluginAsync } from 'fastify';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';

const credentials = {
  accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
};

// Internal client — server↔MinIO operations (delete, etc.) over the private network.
const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT ?? 'http://minio:9000',
  region: 'us-east-1',
  credentials,
  forcePathStyle: true,
});

// Signing client — presigned URLs the device uses must point at the PUBLIC MinIO
// host (e.g. https://s3.plexcontrol.com behind NPM), since the signature is bound
// to that host. Falls back to the internal endpoint for local/dev.
const s3Public = new S3Client({
  endpoint: process.env.MINIO_PUBLIC_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? 'http://minio:9000',
  region: 'us-east-1',
  credentials,
  forcePathStyle: true,
});

const BUCKET = process.env.MINIO_BUCKET ?? 'inventorypro';

interface UploadUrlBody {
  entity_type: string;
  entity_id: string;
  media_type: 'image' | 'video';
  file_extension: string;
}

interface SaveMediaBody {
  entity_type: string;
  entity_id: string;
  media_type: 'image' | 'video';
  url: string;
  thumbnail_url?: string;
  caption?: string;
  is_primary?: boolean;
}

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [(fastify as any).authenticate] };

  // POST /media/upload-url — get signed PUT URL for direct MinIO upload
  fastify.post<{ Body: UploadUrlBody }>('/upload-url', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['entity_type', 'entity_id', 'media_type', 'file_extension'],
        properties: {
          entity_type: { type: 'string' },
          entity_id: { type: 'string' },
          media_type: { type: 'string', enum: ['image', 'video'] },
          file_extension: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { entity_type, entity_id, media_type, file_extension } = request.body;
    const key = `${entity_type}/${entity_id}/${uuid()}.${file_extension}`;
    // ContentType is bound into the presigned signature, so the device MUST send
    // this exact string on its PUT or MinIO returns SignatureDoesNotMatch.
    // Return it so the client can echo it back verbatim.
    const contentType = media_type === 'image' ? `image/${file_extension}` : `video/${file_extension}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Public, command, { expiresIn: 300 });
    const publicUrl = `${process.env.PUBLIC_MEDIA_URL ?? 'https://localhost/media'}/${key}`;

    return { uploadUrl, key, publicUrl, contentType };
  });

  // POST /media — save media record after successful upload
  fastify.post<{ Body: SaveMediaBody }>('/', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['entity_type', 'entity_id', 'media_type', 'url'],
        properties: {
          entity_type: { type: 'string' },
          entity_id: { type: 'string' },
          media_type: { type: 'string' },
          url: { type: 'string' },
          thumbnail_url: { type: 'string' },
          caption: { type: 'string' },
          is_primary: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { entity_type, entity_id, media_type, url, thumbnail_url, caption, is_primary = false } = request.body;
    const userId = (request.user as { sub: string }).sub;

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
      [entity_type, entity_id, media_type, url, thumbnail_url ?? null, caption ?? null, is_primary, userId]
    );
    return reply.status(201).send(rows[0]);
  });

  // GET /media/:entityType/:entityId — list media for an entity
  fastify.get<{ Params: { entityType: string; entityId: string } }>(
    '/:entityType/:entityId', auth, async (request) => {
      const { entityType, entityId } = request.params;
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
  fastify.delete<{ Params: { id: string } }>('/:id', auth, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const { rows } = await fastify.pg.query(
      `SELECT * FROM media WHERE id = $1`,
      [request.params.id]
    );
    const media = rows[0] as { url: string; uploaded_by: string } | undefined;
    if (!media) return reply.status(404).send({ error: 'Not found' });

    // Only uploader or admin may delete
    const { rows: userRows } = await fastify.pg.query(
      `SELECT role FROM users WHERE id = $1`, [userId]
    );
    const role = (userRows[0] as { role: string } | undefined)?.role;
    if (media.uploaded_by !== userId && role !== 'full_admin') {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    // Extract key from URL and delete from MinIO
    const urlObj = new URL(media.url);
    const key = urlObj.pathname.replace(`/${BUCKET}/`, '');
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch {
      // Best-effort — delete DB record regardless
    }

    await fastify.pg.query(`DELETE FROM media WHERE id = $1`, [request.params.id]);
    return { deleted: true };
  });
};

export default routes;
