import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// #32 S6/S7 + #29 I — /sync guards that only fire inside the push/pull handlers
// (the pure column policy is covered in lib/syncPolicy.test.ts):
//  - /sync/push rejects any app_config entry keyed demo_mode — the apex-only
//    demo kill switch is never writable via generic sync, even by a caller who
//    holds system_settings. The wording must match the mobile engine's
//    permanent-rejection regex (/forbidden|cannot|not allowed/i) or the outbox
//    entry retries forever.
//  - messages UPDATE is sender-only, and a deleted_at UPDATE forces body = ''
//    server-side (deleted messages never retain content — #29).
//  - media pull scoping (#29-H): message-attachment media rows from a
//    conversation the caller is not in never sync down; non-message media
//    stays unscoped (the normal shared surface).

const CALLER = 'caller-user-id';
const OTHER = 'other-user-id';
const PERMANENT = /forbidden|cannot|not allowed/i;
const NOW = '2026-07-14T00:00:00.000Z';

// conv-mine: caller is a member; conv-foreign: caller is NOT.
const PARTICIPANTS: Record<string, string[]> = {
  'conv-mine': [CALLER, OTHER],
  'conv-foreign': [OTHER],
};
const MESSAGE_CONV: Record<string, string> = {
  'msg-mine': 'conv-mine',
  'msg-foreign': 'conv-foreign',
};
const MEDIA_ROWS = [
  { id: 'media-item', entity_type: 'item', entity_id: 'item-1' },
  { id: 'media-msg-mine', entity_type: 'message', entity_id: 'msg-mine' },
  { id: 'media-msg-foreign', entity_type: 'message', entity_id: 'msg-foreign' },
];

// Boot-time column introspection result — just the tables these tests write to.
const COLUMNS: Record<string, string[]> = {
  app_config: ['key', 'value', 'updated_at'],
  messages: ['id', 'conversation_id', 'sender_id', 'body', 'urgency', 'created_at', 'updated_at', 'edited_at', 'deleted_at'],
};

// Dispatching fake pg (auth-demo.test.ts pattern). Records every query so the
// tests can assert what SQL actually ran. The media stub HONORS the scope built
// into the query TEXT — an unscoped media query returns everything, so a
// missing mediaScopeSql would surface as a leak in the assertions.
function fakePg(opts: { messageSender?: string } = {}) {
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
      // resolveCaller — the only query that selects u.is_test.
      if (sql.includes('u.is_test')) {
        return { rows: [{ role: 'full_admin', permission_overrides: null, role_overrides: null, is_test: false }] };
      }
      if (sql.includes(`key = 'maintenance_mode'`)) return { rows: [] };
      // messages-UPDATE sender guard lookup.
      if (sql.includes('SELECT sender_id FROM messages')) {
        return { rows: opts.messageSender ? [{ sender_id: opts.messageSender }] : [] };
      }
      if (sql.includes('FROM media')) {
        const scoped = sql.includes(`entity_type != 'message'`)
          && sql.includes('conversation_participants WHERE user_id =');
        if (!scoped) return { rows: MEDIA_ROWS };
        // Emulate the predicate for the caller-id param (last positional in
        // both /pull ($2) and /full ($3)).
        const uid = String(params[params.length - 1]);
        return {
          rows: MEDIA_ROWS.filter(m =>
            m.entity_type !== 'message'
            || (PARTICIPANTS[MESSAGE_CONV[m.entity_id]] ?? []).includes(uid)),
        };
      }
      return { rows: [] };
    },
  };
}

async function buildApp(pg: ReturnType<typeof fakePg>) {
  const app = Fastify();
  app.decorate('pg', pg as never);
  // Passthrough auth that stamps the caller — sync resolves the real role from
  // the DB (fakePg above), never from the token.
  app.decorate('authenticate', async (request: { user?: unknown }) => {
    request.user = { sub: CALLER };
  });
  // sync's import chain pulls in lib/s3.ts, which fails closed at import time
  // without MinIO credentials — set dummies before a DYNAMIC import (same
  // pattern as schema-validation.test.ts).
  process.env.MINIO_ACCESS_KEY ??= 'test-access';
  process.env.MINIO_SECRET_KEY ??= 'test-secret';
  const syncRoutes = (await import('./sync')).default;
  await app.register(syncRoutes, { prefix: '/sync' });
  await app.ready();
  return app;
}

function pushBody(entries: Array<Partial<{ id: string; operation: string; table_name: string; payload: Record<string, unknown> }>>) {
  return { entries: entries.map((e, i) => ({ id: `e${i + 1}`, created_at: NOW, ...e })) };
}

// ── #32: demo_mode is unwritable via generic app_config sync ─────────────────

test('push: app_config demo_mode is rejected as permanent, regardless of op', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([
      { operation: 'INSERT', table_name: 'app_config', payload: { key: 'demo_mode', value: '0', updated_at: NOW } },
      { operation: 'UPDATE', table_name: 'app_config', payload: { key: 'demo_mode', value: '1' } },
    ]),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 2);
  for (const c of body.conflicts) {
    // Must read as permanent to the mobile engine, or the entry wedges the outbox.
    assert.match(c.error, PERMANENT);
    assert.match(c.error, /demo_mode/);
  }
  // The guard rejected BEFORE applyEntry — app_config was never written.
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO app_config')), 'demo_mode must never reach SQL');
  assert.ok(!pg.queries.some(q => q.sql.startsWith('UPDATE app_config')), 'demo_mode must never reach SQL');
  await app.close();
});

test('push: other app_config keys still write (the guard is key-scoped, not table-wide)', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([
      { operation: 'INSERT', table_name: 'app_config', payload: { key: 'approval_threshold_qty', value: '50', updated_at: NOW } },
    ]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.ok, ['e1']);
  assert.deepEqual(body.conflicts, []);
  assert.ok(pg.queries.some(q => q.sql.includes('INSERT INTO app_config')), 'a non-demo_mode key must apply');
  await app.close();
});

// ── #29: messages UPDATE guard (sender-only; deleted_at blanks the body) ─────

test('push: messages UPDATE by a non-sender is a permanent rejection and never runs SQL', async () => {
  const pg = fakePg({ messageSender: OTHER });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([
      { operation: 'UPDATE', table_name: 'messages', payload: { id: 'msg-1', body: 'rewritten', edited_at: NOW } },
    ]),
  });
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 1);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.match(body.conflicts[0].error, /sender/i);
  assert.ok(!pg.queries.some(q => q.sql.startsWith('UPDATE messages')), 'the rewrite must never reach SQL');
  await app.close();
});

test('push: a deleted_at UPDATE forces body = \'\' server-side even when the payload carries content', async () => {
  const pg = fakePg({ messageSender: CALLER });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([
      { operation: 'UPDATE', table_name: 'messages', payload: { id: 'msg-1', deleted_at: NOW, body: 'still here' } },
    ]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.ok, ['e1']);
  const upd = pg.queries.find(q => q.sql.startsWith('UPDATE messages'));
  assert.ok(upd, 'the soft-delete UPDATE must run');
  const m = upd!.sql.match(/\bbody = \$(\d+)/);
  assert.ok(m, 'the UPDATE must set body');
  assert.equal(upd!.params[Number(m![1]) - 1], '', 'a deleted message must never retain its content');
  await app.close();
});

test('push: the sender\'s own edit (body + edited_at) applies', async () => {
  const pg = fakePg({ messageSender: CALLER });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([
      { operation: 'UPDATE', table_name: 'messages', payload: { id: 'msg-1', body: 'edited body', edited_at: NOW } },
    ]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.ok, ['e1']);
  assert.deepEqual(body.conflicts, []);
  const upd = pg.queries.find(q => q.sql.startsWith('UPDATE messages'));
  assert.ok(upd, 'the edit UPDATE must run');
  const m = upd!.sql.match(/\bbody = \$(\d+)/);
  assert.equal(upd!.params[Number(m![1]) - 1], 'edited body');
  assert.match(upd!.sql, /edited_at = \$\d+/);
  await app.close();
});

// ── #29-H: media pull scoping for message attachments ────────────────────────

test('pull: message-attachment media from a foreign conversation is excluded; other media unscoped', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'GET', url: '/sync/pull?since=2020-01-01T00:00:00.000Z' });
  assert.equal(res.statusCode, 200);
  const media = (res.json() as Record<string, { rows: Array<{ id: string }> }>).media.rows;
  assert.deepEqual(media.map(r => r.id).sort(), ['media-item', 'media-msg-mine']);
  await app.close();
});

test('full: the media page is scoped the same way as the incremental pull', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'GET', url: '/sync/full?table=media' });
  assert.equal(res.statusCode, 200);
  const { rows } = res.json() as { rows: Array<{ id: string }> };
  assert.deepEqual(rows.map(r => r.id).sort(), ['media-item', 'media-msg-mine']);
  await app.close();
});
