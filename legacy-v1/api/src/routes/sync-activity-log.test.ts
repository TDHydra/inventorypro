import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// #56 — the audit trail must record what EVERY authenticated user did, always.
//
// The bug (seen in prod telemetry 2026-07-14): a user without `create_jobs`
// creates a job offline. The jobs INSERT is permanently rejected on push and the
// mobile engine DROPS it — but the paired audit row carries job_id, an FK to a
// job that now exists nowhere on the server. The INSERT raised a foreign-key
// violation, the handler masked it as the generic (transient) 'write rejected',
// and the client retried it to MAX_OUTBOX_ATTEMPTS and dead-lettered it. The
// action was never recorded, and the outbox sat stuck.
//
// Same class of loss: entity_id is a bare uuid column, so a non-UUID value
// aborts the whole INSERT with 22P02.
//
// Invariant these tests pin: a dangling or malformed reference DEGRADES (the
// column is nulled, the original id preserved under metadata.orphaned_refs) —
// it never costs us the audit row.

const CALLER = 'caller-user-id';
const NOW = '2026-07-14T00:00:00.000Z';

const LIVE_JOB = '11111111-1111-4111-8111-111111111111';
const DEAD_JOB = '22222222-2222-4222-8222-222222222222'; // never synced (its INSERT was Forbidden-dropped)
const LIVE_LOCATION = '33333333-3333-4333-8333-333333333333';
const DEAD_TEAM = '44444444-4444-4444-8444-444444444444';

// Rows the SERVER actually has. Anything else is a dangling reference.
const EXISTING = new Set([LIVE_JOB, LIVE_LOCATION]);

const COLUMNS: Record<string, string[]> = {
  activity_log: [
    'id', 'user_id', 'team_id', 'action', 'entity_type', 'entity_id',
    'from_location_id', 'to_location_id', 'quantity', 'unit',
    'job_id', 'note', 'metadata', 'device_id', 'created_at', 'synced_at',
    'latitude', 'longitude', 'location_accuracy',
  ],
};

function fakePg(opts: { callerRole?: string; callerOverrides?: Record<string, boolean> | null } = {}) {
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
      if (sql.includes('u.is_test')) {
        // A low-permission caller by default: exactly the user this bug strands.
        // H3: privileged activity_log actions (role_permission_changed, …) are
        // now gated on the matching permission, so a test exercising one of those
        // actions must grant it via callerOverrides (that action is legitimately
        // only performed by a privileged user; a low-priv one is forgery).
        return { rows: [{ role: opts.callerRole ?? 'mitigation_technician', permission_overrides: opts.callerOverrides ?? null, role_overrides: null, is_test: false }] };
      }
      if (sql.includes(`key = 'maintenance_mode'`)) return { rows: [] };
      // The FK existence probe: EXISTS(...) AS "<col>" per checked column.
      if (sql.startsWith('SELECT EXISTS(')) {
        const cols = [...sql.matchAll(/AS "([a-z_]+)"/g)].map(m => m[1]);
        const row: Record<string, boolean> = {};
        cols.forEach((c, i) => { row[c] = EXISTING.has(String(params[i])); });
        return { rows: [row] };
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
  process.env.MINIO_ACCESS_KEY ??= 'test-access';
  process.env.MINIO_SECRET_KEY ??= 'test-secret';
  const syncRoutes = (await import('./sync')).default;
  await app.register(syncRoutes, { prefix: '/sync' });
  await app.ready();
  return app;
}

function logEntry(payload: Record<string, unknown>) {
  return {
    entries: [{
      id: 'e1',
      created_at: NOW,
      operation: 'INSERT',
      table_name: 'activity_log',
      payload: {
        id: '99999999-9999-4999-8999-999999999999',
        action: 'job_created',
        entity_type: 'job',
        created_at: NOW,
        ...payload,
      },
    }],
  };
}

// Pull the INSERT INTO activity_log call and map its params to column names.
function insertedRow(pg: ReturnType<typeof fakePg>): Record<string, unknown> | null {
  const q = pg.queries.find(x => x.sql.includes('INSERT INTO activity_log'));
  if (!q) return null;
  // Param order is fixed by the handler's INSERT (see routes/sync.ts).
  const order = [
    'id', 'user_id', 'team_id', 'action', 'entity_type', 'entity_id',
    'from_location_id', 'to_location_id', 'quantity', 'unit',
    'job_id', 'note', 'metadata', 'device_id', 'created_at',
    'latitude', 'longitude', 'location_accuracy',
  ];
  const row: Record<string, unknown> = {};
  order.forEach((c, i) => { row[c] = q.params[i]; });
  return row;
}

test('#56 an audit row whose job_id was never synced still RECORDS (fk nulled, id preserved)', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: logEntry({ entity_id: DEAD_JOB, job_id: DEAD_JOB, note: 'Job Tw' }),
  });

  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string }> };
  assert.deepEqual(body.conflicts, [], 'a dangling FK must never reject the audit row');
  assert.deepEqual(body.ok, ['e1']);

  const row = insertedRow(pg);
  assert.ok(row, 'the audit row must still be INSERTed');
  assert.equal(row.job_id, null, 'the dangling job_id degrades to NULL');
  assert.equal(row.action, 'job_created', 'the action itself is preserved');
  // entity_id has no FK — a well-formed uuid stays, even if the job never landed.
  assert.equal(row.entity_id, DEAD_JOB);
  // No information is lost: the dropped id is recoverable from metadata.
  assert.match(String(row.metadata), /orphaned_refs/);
  assert.match(String(row.metadata), new RegExp(DEAD_JOB));
  await app.close();
});

test('#56 references that DO exist are preserved untouched', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: logEntry({
      action: 'checkout', entity_type: 'item',
      job_id: LIVE_JOB, from_location_id: LIVE_LOCATION,
      metadata: JSON.stringify({ qty: 2 }),
    }),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);

  const row = insertedRow(pg);
  assert.equal(row?.job_id, LIVE_JOB, 'a live FK must NOT be nulled');
  assert.equal(row?.from_location_id, LIVE_LOCATION);
  // Untouched metadata keeps its shape — no orphaned_refs key invented.
  assert.equal(String(row?.metadata), JSON.stringify({ qty: 2 }));
  await app.close();
});

test('H3: a low-priv caller forging a privileged action (role_permission_changed) is rejected, no row', async () => {
  const pg = fakePg(); // default mitigation_technician: no manage_roles_permissions
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: logEntry({ action: 'role_permission_changed', entity_type: 'role_settings' }),
  });
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string; code: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts[0].code, 'FORBIDDEN');
  assert.match(body.conflicts[0].error, /manage_roles_permissions/);
  assert.equal(insertedRow(pg), null, 'the forged audit row must never be INSERTed');
  await app.close();
});

test('H3: a server-only action (login) can never be written by a client, no row', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: logEntry({ action: 'login', entity_type: 'user' }),
  });
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string; code: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts[0].code, 'NOT_ALLOWED');
  assert.equal(insertedRow(pg), null, 'a server-side-only action must never be client-written');
  await app.close();
});

test('#56 a dangling team_id degrades too (every FK column, not just job_id)', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: logEntry({ action: 'team_member_added', entity_type: 'team', team_id: DEAD_TEAM }),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.ok, ['e1']);
  assert.deepEqual(body.conflicts, []);
  assert.equal(insertedRow(pg)?.team_id, null);
  await app.close();
});

test('#56 a malformed (non-uuid) entity_id does not abort the audit row (22P02 trap)', async () => {
  // role_permission_changed is H3-gated to manage_roles_permissions — the caller
  // who legitimately logs it holds that grant; the non-uuid entity_id degradation
  // is what this test pins.
  const pg = fakePg({ callerOverrides: { manage_roles_permissions: true } });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    // Logging a role/taxonomy STRING key into a uuid column — the known trap.
    payload: logEntry({ action: 'role_permission_changed', entity_type: 'role_settings', entity_id: 'mitigation_technician' }),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.ok, ['e1']);
  assert.deepEqual(body.conflicts, []);

  const row = insertedRow(pg);
  assert.equal(row?.entity_id, null, 'a non-uuid entity_id must be nulled, not sent to a uuid column');
  assert.match(String(row?.metadata), /mitigation_technician/, 'the original key survives in metadata');
  await app.close();
});
