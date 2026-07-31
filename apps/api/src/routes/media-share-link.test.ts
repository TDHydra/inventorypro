import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// #180 v1 — POST /media/:id/share-link mints a longer-lived presigned GET URL
// for the Android share sheet (mobile hands the URL straight to Share.share()).
// Message attachments are conversation-private. Pool shares mirror the sync
// pull's audience scope: uploader / everyone / team / users list — anyone who
// can see the photo in their media hub may share it externally.

const CALLER = 'caller-user-id';
const OTHER = 'other-user-id';
const TEAMMATE = 'teammate-user-id';

const MESSAGE_MEMBERS: Record<string, string[]> = {
  'msg-mine': [CALLER, OTHER],
  'msg-foreign': [OTHER],
};

// Users who share at least one team with CALLER (drives the team_members probe).
const CALLER_TEAMMATES = new Set([TEAMMATE]);

interface MediaRow {
  id: string; url: string; entity_type: string; entity_id: string;
  uploaded_by: string | null; audience: string | null; audience_user_ids: string | null;
}

// Media rows keyed by id — mirrors what `SELECT * FROM media WHERE id = $1` returns.
const MEDIA_ROWS: Record<string, MediaRow> = {
  'media-job': { id: 'media-job', url: 'https://localhost/media/job/job-1/photo.jpg', entity_type: 'job', entity_id: 'job-1', uploaded_by: OTHER, audience: null, audience_user_ids: null },
  'media-msg-mine': { id: 'media-msg-mine', url: 'https://localhost/media/message/msg-mine/photo.jpg', entity_type: 'message', entity_id: 'msg-mine', uploaded_by: OTHER, audience: null, audience_user_ids: null },
  'media-msg-foreign': { id: 'media-msg-foreign', url: 'https://localhost/media/message/msg-foreign/photo.jpg', entity_type: 'message', entity_id: 'msg-foreign', uploaded_by: OTHER, audience: null, audience_user_ids: null },
  'media-pool-caller': { id: 'media-pool-caller', url: `https://localhost/media/pool/${CALLER}/photo.jpg`, entity_type: 'pool', entity_id: CALLER, uploaded_by: CALLER, audience: 'team', audience_user_ids: null },
  'media-pool-everyone': { id: 'media-pool-everyone', url: `https://localhost/media/pool/${OTHER}/photo.jpg`, entity_type: 'pool', entity_id: OTHER, uploaded_by: OTHER, audience: 'everyone', audience_user_ids: null },
  'media-pool-team-mate': { id: 'media-pool-team-mate', url: `https://localhost/media/pool/${TEAMMATE}/photo.jpg`, entity_type: 'pool', entity_id: TEAMMATE, uploaded_by: TEAMMATE, audience: 'team', audience_user_ids: null },
  'media-pool-team-foreign': { id: 'media-pool-team-foreign', url: `https://localhost/media/pool/${OTHER}/photo.jpg`, entity_type: 'pool', entity_id: OTHER, uploaded_by: OTHER, audience: 'team', audience_user_ids: null },
  'media-pool-users-in': { id: 'media-pool-users-in', url: `https://localhost/media/pool/${OTHER}/photo.jpg`, entity_type: 'pool', entity_id: OTHER, uploaded_by: OTHER, audience: 'users', audience_user_ids: `["${OTHER}","${CALLER}"]` },
  'media-pool-users-out': { id: 'media-pool-users-out', url: `https://localhost/media/pool/${OTHER}/photo.jpg`, entity_type: 'pool', entity_id: OTHER, uploaded_by: OTHER, audience: 'users', audience_user_ids: `["${OTHER}"]` },
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
      if (sql.includes('FROM team_members')) {
        // Route probes: does the UPLOADER ($1) sit in one of the CALLER's ($2) teams?
        const [uploaderId, callerId] = params.map(String);
        const shared = callerId === CALLER && CALLER_TEAMMATES.has(uploaderId);
        return { rows: shared ? [{ ok: 1 }] : [] };
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

test("share-link for the caller's own pool media presigns (200)", async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/media-pool-caller/share-link' });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("share-link for another user's everyone-audience pool share presigns (200)", async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/media-pool-everyone/share-link' });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("share-link for a teammate's team-audience pool share presigns (200)", async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/media-pool-team-mate/share-link' });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("share-link for a NON-teammate's team-audience pool share is 403", async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/media-pool-team-foreign/share-link' });
  assert.equal(res.statusCode, 403);
  assert.match((res.json() as { error: string }).error, /audience/i);
  await app.close();
});

test('share-link for a users-audience pool share naming the caller presigns (200)', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/media-pool-users-in/share-link' });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('share-link for a users-audience pool share NOT naming the caller is 403', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'POST', url: '/media/media-pool-users-out/share-link' });
  assert.equal(res.statusCode, 403);
  assert.match((res.json() as { error: string }).error, /audience/i);
  await app.close();
});
