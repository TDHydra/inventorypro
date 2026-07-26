import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// #76 server: resolution reconcile — integration coverage for the two pieces
// that can't be unit-tested in isolation from the push handler:
//  1. The fuel_up carve-out (sync.ts, deliberately NOT syncPolicy.ts's
//     OPERATION_PERM — see the HARD RULE in the task brief): a crew member
//     without edit_inventory may still INSERT a vehicle_service_records row
//     when payload.type === 'fuel_up'; every other kind (oil change, etc.)
//     keeps requiring edit_inventory, and only for INSERT.
//  2. The team-override union layer end-to-end through resolveCaller: a
//     tier-1 crew member with no personal create_jobs grant, but a positive
//     team_permission_overrides.create_jobs in a team they belong to, gets
//     their jobs INSERT accepted.
// The pure resolution-order unit tests live in lib/permissions.test.ts.

const CALLER = 'caller-user-id';
const NOW = '2026-07-26T00:00:00.000Z';

const COLUMNS: Record<string, string[]> = {
  vehicle_service_records: [
    'id', 'vehicle_location_id', 'target', 'event_date', 'type', 'notes',
    'odometer', 'created_by', 'created_at', 'updated_at', 'payer', 'job_id', 'cost',
  ],
  jobs: ['id', 'name', 'status', 'created_by', 'created_at', 'updated_at', 'team_id'],
};

interface FakePgOpts {
  callerRole?: string;
  /** permission_overrides on the caller's users row. */
  callerOverrides?: Record<string, boolean> | null;
  /** One entry per team_members row the caller belongs to. */
  teamOverrides?: Array<Record<string, boolean> | null>;
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
      // resolveCaller — the combined role/role_overrides/team_overrides query.
      if (sql.includes('u.is_test')) {
        return {
          rows: [{
            role: opts.callerRole ?? 'construction_crew',
            permission_overrides: opts.callerOverrides ?? null,
            is_test: false,
            role_overrides: null,
            team_overrides: opts.teamOverrides ?? [],
          }],
        };
      }
      if (sql.includes(`key = 'maintenance_mode'`)) return { rows: [] };
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
  // sync's import chain pulls in lib/s3.ts, which fails closed at import time
  // without MinIO credentials — set dummies before a DYNAMIC import (same
  // pattern as schema-validation.test.ts / sync-guards.test.ts).
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

// ── fuel_up carve-out ─────────────────────────────────────────────────────────

test('push: crew fuel_up vehicle_service_records INSERT is accepted without edit_inventory', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' }); // tier1: edit_inventory=false
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'vehicle_service_records',
      payload: {
        id: 'svc-1', vehicle_location_id: 'veh-1', target: 'vehicle',
        event_date: NOW, type: 'fuel_up', notes: '10 gal', odometer: null,
        created_by: CALLER, updated_at: NOW,
      },
    }]),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string }> };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  await app.close();
});

test('push: crew non-fuel_up (oil change) vehicle_service_records INSERT is still rejected', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' }); // tier1: edit_inventory=false
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'vehicle_service_records',
      payload: {
        id: 'svc-2', vehicle_location_id: 'veh-1', target: 'vehicle',
        event_date: NOW, type: 'oil_change', notes: null, odometer: null,
        created_by: CALLER, updated_at: NOW,
      },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 1);
  assert.match(body.conflicts[0].error, /requires edit_inventory/);
  await app.close();
});

test('push: an edit_inventory holder may still INSERT a non-fuel_up service record', async () => {
  const pg = fakePg({ callerRole: 'production_manager' }); // tier2: edit_inventory=true
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'vehicle_service_records',
      payload: {
        id: 'svc-3', vehicle_location_id: 'veh-1', target: 'vehicle',
        event_date: NOW, type: 'oil_change', notes: null, odometer: null,
        created_by: CALLER, updated_at: NOW,
      },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.ok, ['e1']);
  assert.deepEqual(body.conflicts, []);
  await app.close();
});

test('push: fuel_up carve-out does NOT extend to UPDATE — still requires edit_inventory', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'UPDATE', table_name: 'vehicle_service_records',
      payload: { id: 'svc-1', type: 'fuel_up', notes: 'edited' },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 1);
  assert.match(body.conflicts[0].error, /requires edit_inventory/);
  await app.close();
});

// ── team-override union, end to end through resolveCaller ────────────────────

test('push: a team-override-granted create_jobs tech creates a job — accepted via union', async () => {
  // construction_crew (tier1) defaults create_jobs=false; granted via a team override.
  const pg = fakePg({ callerRole: 'construction_crew', teamOverrides: [{ create_jobs: true }] });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'jobs',
      payload: { id: 'job-1', name: 'New job', status: 'open', created_by: CALLER, updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  await app.close();
});

test('push: denial in one team + grant in another team ⇒ accepted (union, grants-only)', async () => {
  const pg = fakePg({
    callerRole: 'construction_crew',
    teamOverrides: [{ create_jobs: false }, { create_jobs: true }],
  });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'jobs',
      payload: { id: 'job-2', name: 'Another job', status: 'open', created_by: CALLER, updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  await app.close();
});

test('push: no team grant ⇒ crew create_jobs INSERT still rejected (baseline unchanged)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', teamOverrides: [{ create_jobs: false }] });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'jobs',
      payload: { id: 'job-3', name: 'Yet another job', status: 'open', created_by: CALLER, updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 1);
  assert.match(body.conflicts[0].error, /requires create_jobs/);
  await app.close();
});
