import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { ShareEmailSender } from '../lib/shareEmail';

// #171 email leg: pins the wiring of the media-share push hook (sync.ts, the
// #87 "pool photo share → notify" block) to the new email leg — behind
// MEDIA_SHARE_EMAIL=1 (default OFF), fire-and-forget, using the same
// resolvePoolRecipients list as the existing push/inbox notify, skipping
// users with no email, and never emailing the 'everyone' audience (mirrors
// its quiet-push rule). The hook itself is `void (async () => {...})()` —
// every fake-pg await settles in microtasks, so a couple of setImmediate hops
// after the response let it finish (on_call_coverage fan-out precedent,
// sync-guards.test.ts:1014-1034).

// entity_id/uploaded_by/audience_user_ids all pass through KEY_RE / UUID_RE
// (lib/syncPolicy.ts validateMediaWrite) — UUID-shaped ids throughout.
const CALLER = '11111111-1111-1111-1111-111111111111';
const RECIPIENT_A = '22222222-2222-2222-2222-222222222222';
const RECIPIENT_B = '33333333-3333-3333-3333-333333333333';
const NOW = '2026-07-30T00:00:00.000Z';

const COLUMNS: Record<string, string[]> = {
  media: [
    'id', 'entity_type', 'entity_id', 'media_type', 'url', 'thumbnail_url',
    'caption', 'location_note', 'is_primary', 'uploaded_by', 'created_at',
    'updated_at', 'audience', 'audience_user_ids',
  ],
};

interface FakePgOpts {
  /** users.email for recipients resolved by resolvePoolRecipients ('users' audience). */
  emailsById?: Record<string, string | null>;
}

function fakePg(opts: FakePgOpts = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('information_schema.columns')) {
        const rows: Array<{ table_name: string; column_name: string }> = [];
        for (const [t, cols] of Object.entries(COLUMNS)) {
          for (const c of cols) rows.push({ table_name: t, column_name: c });
        }
        return { rows };
      }
      // resolveCaller — full_admin, so every permission/tier check passes.
      if (sql.includes('u.is_test')) {
        return { rows: [{ role: 'full_admin', permission_overrides: null, role_overrides: null, is_test: false }] };
      }
      if (sql.includes(`key = 'maintenance_mode'`)) return { rows: [] };
      // resolvePoolRecipients ('users' audience): active-users filter.
      if (sql.includes('FROM users WHERE id = ANY($1) AND active = TRUE')) {
        return { rows: (params[0] as string[]).map(id => ({ id })) };
      }
      // 'everyone' audience: every active user except the sender.
      if (sql.includes('FROM users WHERE active = TRUE AND id !=')) {
        return { rows: [{ id: RECIPIENT_A }] };
      }
      // #171 email leg's own recipient-email lookup.
      if (sql.includes('SELECT email FROM users')) {
        const ids = params[0] as string[];
        const rows = ids
          .map(id => ({ id, email: opts.emailsById?.[id] ?? null }))
          .filter(r => r.email != null)
          .map(r => ({ email: r.email }));
        return { rows };
      }
      return { rows: [] };
    },
  };
}

async function buildApp(pg: ReturnType<typeof fakePg>, shareEmailSender?: ShareEmailSender) {
  const app = Fastify();
  app.decorate('pg', pg as never);
  app.decorate('authenticate', async (request: { user?: unknown }) => {
    request.user = { sub: CALLER };
  });
  process.env.MINIO_ACCESS_KEY ??= 'test-access';
  process.env.MINIO_SECRET_KEY ??= 'test-secret';
  const syncRoutes = (await import('./sync')).default;
  await app.register(syncRoutes, { prefix: '/sync', ...(shareEmailSender ? { shareEmailSender } : {}) });
  await app.ready();
  return app;
}

function mediaShareEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    operation: 'INSERT',
    table_name: 'media',
    created_at: NOW,
    payload: {
      id: 'media-share-1',
      entity_type: 'pool',
      entity_id: CALLER,
      media_type: 'image',
      url: `https://localhost/media/pool/${CALLER}/11111111-1111-1111-1111-111111111111.jpg`,
      caption: null,
      location_note: 'Kitchen',
      is_primary: false,
      uploaded_by: CALLER,
      created_at: NOW,
      audience: 'users',
      audience_user_ids: JSON.stringify([RECIPIENT_A, RECIPIENT_B]),
      ...overrides,
    },
  };
}

async function settle() {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

test('MEDIA_SHARE_EMAIL off (default): no email is attempted', async () => {
  delete process.env.MEDIA_SHARE_EMAIL;
  const pg = fakePg({ emailsById: { [RECIPIENT_A]: 'a@example.com', [RECIPIENT_B]: 'b@example.com' } });
  const sent: Array<{ to: string }> = [];
  const stub: ShareEmailSender = { sendMediaShareEmail: async (input) => { sent.push(input); return { sent: true }; } };
  const app = await buildApp(pg, stub);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: { entries: [mediaShareEntry()] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { ok: string[] }).ok, ['e1']);
  await settle();
  assert.deepEqual(sent, []);
  assert.ok(!pg.queries.some(q => q.sql.includes('SELECT email FROM users')), 'no email lookup at all when the flag is off');
  await app.close();
});

test('MEDIA_SHARE_EMAIL=1 + no SMTP configured (default sender): degrades gracefully, never fails the sync write', async () => {
  process.env.MEDIA_SHARE_EMAIL = '1';
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_FROM;
  const pg = fakePg({ emailsById: { [RECIPIENT_A]: 'a@example.com', [RECIPIENT_B]: 'b@example.com' } });
  const app = await buildApp(pg); // no injected sender — exercises the real default (mail.ts) sender
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: { entries: [mediaShareEntry()] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { ok: string[] }).ok, ['e1'], 'the sync write itself succeeds regardless of SMTP');
  await settle();
  delete process.env.MEDIA_SHARE_EMAIL;
  await app.close();
});

test('MEDIA_SHARE_EMAIL=1: injected sender receives exactly the resolved recipients\' emails', async () => {
  process.env.MEDIA_SHARE_EMAIL = '1';
  const pg = fakePg({ emailsById: { [RECIPIENT_A]: 'a@example.com', [RECIPIENT_B]: null } });
  const sent: Array<{ to: string; senderName: string; note: string | null; mediaId: string }> = [];
  const stub: ShareEmailSender = { sendMediaShareEmail: async (input) => { sent.push(input); return { sent: true }; } };
  const app = await buildApp(pg, stub);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: { entries: [mediaShareEntry()] } });
  assert.equal(res.statusCode, 200);
  await settle();
  // Recipient B has no email on file — skipped; recipient A gets the email.
  assert.deepEqual(sent.map(s => s.to), ['a@example.com']);
  assert.equal(sent[0].mediaId, 'media-share-1');
  assert.equal(sent[0].note, 'Kitchen');
  delete process.env.MEDIA_SHARE_EMAIL;
  await app.close();
});

test('MEDIA_SHARE_EMAIL=1: the \'everyone\' audience never emails (mirrors its quiet-push rule)', async () => {
  process.env.MEDIA_SHARE_EMAIL = '1';
  const pg = fakePg({ emailsById: { [RECIPIENT_A]: 'a@example.com' } });
  const sent: Array<{ to: string }> = [];
  const stub: ShareEmailSender = { sendMediaShareEmail: async (input) => { sent.push(input); return { sent: true }; } };
  const app = await buildApp(pg, stub);
  const entry = mediaShareEntry({ audience: 'everyone', audience_user_ids: null });
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: { entries: [entry] } });
  assert.equal(res.statusCode, 200);
  await settle();
  assert.deepEqual(sent, []);
  assert.ok(!pg.queries.some(q => q.sql.includes('SELECT email FROM users')), 'everyone audience must never even look up emails');
  delete process.env.MEDIA_SHARE_EMAIL;
  await app.close();
});
