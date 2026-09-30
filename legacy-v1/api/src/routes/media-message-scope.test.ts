import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// #29-H — message attachments are conversation-private on the REST surface too:
// presigning an upload (/media/upload-url), saving the row (POST /media), and
// listing (GET /media/message/:id) must all 403 for a caller who is not a
// participant of the message's conversation. The sync pull side of the same
// boundary (mediaScopeSql) is covered in sync-guards.test.ts.

const CALLER = 'caller-user-id';
const OTHER = 'other-user-id';

// msg-mine lives in a conversation the caller is in; msg-foreign does not.
const MESSAGE_MEMBERS: Record<string, string[]> = {
  'msg-mine': [CALLER, OTHER],
  'msg-foreign': [OTHER],
};

const MEDIA_UUID = '123e4567-e89b-42d3-a456-426614174000';

// Dispatching fake pg (auth-demo.test.ts pattern). The participant check is the
// only query joining conversation_participants; it is answered from the
// membership table above, keyed on (message id, caller id).
function fakePg() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      // requirePermission('upload_media') role lookup — grant everything.
      if (sql.includes('role_overrides') && sql.includes('FROM users')) {
        return { rows: [{ role: 'full_admin', permission_overrides: null, role_overrides: null }] };
      }
      if (sql.includes('JOIN conversation_participants')) {
        const [messageId, uid] = params.map(String);
        const member = (MESSAGE_MEMBERS[messageId] ?? []).includes(uid);
        return { rows: member ? [{ ok: 1 }] : [] };
      }
      if (sql.includes('INSERT INTO media')) {
        return { rows: [{ id: 'new-media-row' }] };
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
  // media.ts imports lib/s3.ts, which fails closed at import time without MinIO
  // credentials — set dummies before a DYNAMIC import (schema-validation.test.ts
  // pattern). Presigning is offline, so the happy path needs no real MinIO.
  process.env.MINIO_ACCESS_KEY ??= 'test-access';
  process.env.MINIO_SECRET_KEY ??= 'test-secret';
  const mediaRoutes = (await import('./media')).default;
  await app.register(mediaRoutes, { prefix: '/media' });
  await app.ready();
  return app;
}

test('upload-url for a foreign message is 403 (non-participant cannot presign)', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/media/upload-url',
    payload: { entity_type: 'message', entity_id: 'msg-foreign', media_type: 'image', file_extension: 'jpg', content_length: 1024 },
  });
  assert.equal(res.statusCode, 403);
  assert.match((res.json() as { error: string }).error, /participant/i);
  await app.close();
});

test('upload-url for a message in the caller\'s own conversation presigns', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({
    method: 'POST', url: '/media/upload-url',
    payload: { entity_type: 'message', entity_id: 'msg-mine', media_type: 'image', file_extension: 'jpg', content_length: 1024 },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { key: string; uploadUrl: string };
  assert.ok(body.key.startsWith('message/msg-mine/'), 'the issued key is anchored to the message');
  assert.ok(body.uploadUrl, 'a presigned URL is returned');
  await app.close();
});

test('POST /media for a foreign message is 403 — the participant gate, not key validation, rejects it', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/media',
    payload: {
      entity_type: 'message', entity_id: 'msg-foreign', media_type: 'image',
      // A perfectly server-shaped key: only membership can be the reason for the 403.
      key: `message/msg-foreign/${MEDIA_UUID}.jpg`,
    },
  });
  assert.equal(res.statusCode, 403);
  assert.match((res.json() as { error: string }).error, /participant/i);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO media')), 'no row may be saved');
  await app.close();
});

test('POST /media for a message in the caller\'s own conversation saves (201)', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/media',
    payload: {
      entity_type: 'message', entity_id: 'msg-mine', media_type: 'image',
      key: `message/msg-mine/${MEDIA_UUID}.jpg`,
    },
  });
  assert.equal(res.statusCode, 201);
  assert.ok(pg.queries.some(q => q.sql.includes('INSERT INTO media')), 'the row is saved');
  await app.close();
});

test('GET /media/message/:id for a foreign message is 403 (REST list cannot bypass the sync scope)', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'GET', url: '/media/message/msg-foreign' });
  assert.equal(res.statusCode, 403);
  await app.close();
});

// #87 — pool shares are keyed to the UPLOADER's user id, and user ids are
// discoverable via the public /auth/roster. The REST list must therefore be
// uploader-only; recipients receive their pool rows through the scoped sync
// pull (mediaScopeSql), never through this route.

test('GET /media/pool/:id for the caller\'s OWN pool lists (200)', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'GET', url: `/media/pool/${CALLER}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { media: [] });
  await app.close();
});

test('GET /media/pool/:id for ANOTHER user\'s pool is 403 (pool media is uploader-only via REST)', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'GET', url: `/media/pool/${OTHER}` });
  assert.equal(res.statusCode, 403);
  assert.match((res.json() as { error: string }).error, /uploader-only/i);
  assert.ok(!pg.queries.some(q => q.sql.includes('FROM media')), 'no media rows may be read');
  await app.close();
});
