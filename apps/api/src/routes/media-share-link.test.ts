import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// #180 v1 — POST /media/:id/share-link mints a longer-lived presigned GET URL
// for the Android share sheet (mobile hands the URL straight to Share.share()).
// Authorization must mirror GET /media/:entityType/:entityId: ordinary entity
// media is readable by any authenticated caller, message attachments are
// conversation-private, and pool shares are uploader-only via REST.

const CALLER = 'caller-user-id';
const OTHER = 'other-user-id';

const MESSAGE_MEMBERS: Record<string, string[]> = {
  'msg-mine': [CALLER, OTHER],
  'msg-foreign': [OTHER],
};

// Media rows keyed by id — mirrors what `SELECT * FROM media WHERE id = $1` returns.
const MEDIA_ROWS: Record<string, { id: string; url: string; entity_type: string; entity_id: string }> = {
  'media-job': { id: 'media-job', url: 'https://localhost/media/job/job-1/photo.jpg', entity_type: 'job', entity_id: 'job-1' },
  'media-msg-mine': { id: 'media-msg-mine', url: 'https://localhost/media/message/msg-mine/photo.jpg', entity_type: 'message', entity_id: 'msg-mine' },
  'media-msg-foreign': { id: 'media-msg-foreign', url: 'https://localhost/media/message/msg-foreign/photo.jpg', entity_type: 'message', entity_id: 'msg-foreign' },
  'media-pool-caller': { id: 'media-pool-caller', url: `https://localhost/media/pool/${CALLER}/photo.jpg`, entity_type: 'pool', entity_id: CALLER },
  'media-pool-other': { id: 'media-pool-other', url: `https://localhost/media/pool/${OTHER}/photo.jpg`, entity_type: 'pool', entity_id: OTHER },
};

function fakePg() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('FROM media WHERE id')) {
        const row = MEDIA_ROWS[String(params[0])];
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('JOIN conversation_participants')) {
        const [messageId, uid] = params.map(String);
        const member = (MESSAGE_MEMBERS[messageId] ?? []).includes(uid);
        return { rows: member ? [{ ok: 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

async function buildApp(pg: ReturnType<typeof fakePg>) {
  const app = Fastify();
  app.decorate('pg', pg as never);
  app.decorate('authenticate', async (request: { user?: unknown }) => {
    request.user = { sub: CALLER };
  });
  // media.ts's lib/s3.ts fails closed without MinIO credentials at import time.
  process.env.MINIO_ACCESS_KEY ??= 'test-access';
  process.env.MINIO_SECRET_KEY ??= 'test-secret';
  const mediaRoutes = (await import('./media')).default;
  await app.register(mediaRoutes, { prefix: '/media' });
  await app.ready();
  return app;
}

test('share-link for an ordinary entity (job) media row presigns (200)', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/media-job/share-link' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { shareUrl: string; expiresInSeconds: number };
  assert.ok(body.shareUrl, 'a presigned share URL is returned');
  assert.equal(body.expiresInSeconds, 7 * 24 * 60 * 60, 'expiry is the 7-day SigV4 ceiling');
  await app.close();
});

test('share-link for a missing media id is 404', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/does-not-exist/share-link' });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('share-link for a message the caller participates in presigns (200)', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/media-msg-mine/share-link' });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('share-link for a message the caller does not participate in is 403', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/media-msg-foreign/share-link' });
  assert.equal(res.statusCode, 403);
  assert.match((res.json() as { error: string }).error, /participant/i);
  await app.close();
});

test('share-link for the caller\'s own pool media presigns (200)', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/media-pool-caller/share-link' });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('share-link for another user\'s pool media is 403 (pool media is uploader-only via REST)', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/media-pool-other/share-link' });
  assert.equal(res.statusCode, 403);
  assert.match((res.json() as { error: string }).error, /uploader-only/i);
  await app.close();
});
