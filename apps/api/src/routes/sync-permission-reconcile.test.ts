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
  rooms: ['id', 'name', 'active', 'created_at', 'updated_at'],
  // #204: the two permission_overrides writers reachable through the generic
  // sync outbox (see touchTeamsAndLocationsIfViewPermsChanged's call site).
  role_settings: ['role', 'min_pin_length', 'permission_overrides', 'color', 'dashboard_preset_id', 'updated_at', 'idle_reauth_minutes'],
  users: [
    'id', 'name', 'role', 'pin_hash', 'pin_length_required', 'permission_overrides',
    'active', 'expires_at', 'created_at', 'updated_at', 'pin_set', 'email',
  ],
};

interface FakePgOpts {
  callerRole?: string;
  /** permission_overrides on the caller's users row. */
  callerOverrides?: Record<string, boolean> | null;
  /** One entry per team_members row the caller belongs to. */
  teamOverrides?: Array<Record<string, boolean> | null>;
  // #204: users writes (sync.ts's target-role/tier guard) pre-read the target
  // row via `SELECT role, active FROM users WHERE id = $1` — keyed by id so a
  // test can stand up a target distinct from CALLER.
  targetUsers?: Record<string, { role: string; active?: boolean }>;
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
      // #204: users write target-role/tier guard pre-read.
      if (sql.includes('SELECT role, active FROM users WHERE id = $1')) {
        const u = opts.targetUsers?.[String(params[0])];
        return { rows: u ? [{ role: u.role, active: u.active ?? true }] : [] };
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

test('push: crew fuel_up INSERT carrying a cost is rejected without edit_inventory (financial column stays gated)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' }); // tier1: edit_inventory=false
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'vehicle_service_records',
      payload: {
        id: 'svc-4', vehicle_location_id: 'veh-1', target: 'vehicle',
        event_date: NOW, type: 'fuel_up', notes: '10 gal', odometer: null,
        cost: 42.5, payer: 'Office', created_by: CALLER, updated_at: NOW,
      },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 1);
  assert.match(body.conflicts[0].error, /cost.*requires edit_inventory/);
  await app.close();
});

test('push: crew fuel_up INSERT with payer/job_id but no cost is still accepted (only cost is gated)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' }); // tier1: edit_inventory=false
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'vehicle_service_records',
      payload: {
        id: 'svc-5', vehicle_location_id: 'veh-1', target: 'vehicle',
        event_date: NOW, type: 'fuel_up', notes: '10 gal', odometer: null,
        payer: 'Office', job_id: 'job-9', created_by: CALLER, updated_at: NOW,
      },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  await app.close();
});

test('push: an edit_inventory holder may set cost on a fuel_up INSERT', async () => {
  const pg = fakePg({ callerRole: 'production_manager' }); // tier2: edit_inventory=true
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'vehicle_service_records',
      payload: {
        id: 'svc-6', vehicle_location_id: 'veh-1', target: 'vehicle',
        event_date: NOW, type: 'fuel_up', notes: '10 gal', odometer: null,
        cost: 42.5, payer: 'Office', created_by: CALLER, updated_at: NOW,
      },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  await app.close();
});

test('push: a view_financial_data holder WITHOUT edit_inventory may set cost (office receipt)', async () => {
  // The client offers the cost field on view_financial_data, not edit_inventory
  // (AddServiceRecordSheet canViewFinancial). Tier 3 has exactly this split —
  // an edit_inventory-keyed gate would reject every office receipt with a cost.
  const pg = fakePg({ callerRole: 'office_manager' }); // tier3: view_financial=true, edit_inventory=false
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'vehicle_service_records',
      payload: {
        id: 'svc-7', vehicle_location_id: 'veh-1', target: 'vehicle',
        event_date: NOW, type: 'fuel_up', notes: '10 gal', odometer: null,
        cost: 42.5, payer: 'Office', created_by: CALLER, updated_at: NOW,
      },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
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

// ── #173 rooms carve-out ──────────────────────────────────────────────────────
// rooms is a synced catalog gated on upload_media OR edit_inventory — an OR of
// two permissions doesn't fit OPERATION_PERM's one-permission-per-op shape, so
// (like fuel_up above) it's a dedicated carve-out branch in sync.ts, not an
// OPERATION_PERM entry.

test('push: rooms INSERT is accepted for a caller with upload_media but not edit_inventory', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' }); // tier1: upload_media=true, edit_inventory=false
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'rooms',
      payload: { id: 'room-1', name: 'Kitchen', active: true, created_at: NOW, updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  await app.close();
});

test('push: rooms INSERT is accepted for a caller with edit_inventory but not upload_media', async () => {
  // temporary_employee defaults BOTH false; grant edit_inventory only via override.
  const pg = fakePg({ callerRole: 'temporary_employee', callerOverrides: { edit_inventory: true } });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'rooms',
      payload: { id: 'room-2', name: 'Garage', active: true, created_at: NOW, updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  await app.close();
});

test('push: rooms INSERT is rejected for a caller with neither upload_media nor edit_inventory', async () => {
  const pg = fakePg({ callerRole: 'temporary_employee' }); // both default false
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'INSERT', table_name: 'rooms',
      payload: { id: 'room-3', name: 'Basement', active: true, created_at: NOW, updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 1);
  assert.match(body.conflicts[0].error, /requires upload_media or edit_inventory/);
  await app.close();
});

test('push: rooms UPDATE follows the same OR-gate as INSERT', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' }); // upload_media=true only
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'UPDATE', table_name: 'rooms',
      payload: { id: 'room-1', name: 'Kitchen (renamed)', updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  await app.close();
});

test('push: rooms DELETE is NOT covered by the carve-out — falls through to the generic DENY (no OPERATION_PERM entry)', async () => {
  const pg = fakePg({ callerRole: 'full_admin' }); // holds both upload_media and edit_inventory
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'DELETE', table_name: 'rooms',
      payload: { id: 'room-1' },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 1);
  assert.match(body.conflicts[0].error, /not permitted via sync/);
  await app.close();
});

// ── #204: watermark fix — bulk touch fires from the sync outbox writers ─────
// touchTeamsAndLocationsIfViewPermsChanged unit tests (syncPolicy.test.ts) cover
// the helper's own presence-check logic in isolation. These integration tests
// confirm the two real call sites in routes/sync.ts (role_settings outbox path,
// users outbox path) actually reach it end-to-end through /sync/push — using
// callerRole: 'full_admin' throughout so the tier guard, the destructive-grant
// guard (role_settings), and the target-role/tier guard (users) all clear
// without extra fixture plumbing, isolating the assertions to the touch itself.

test('push: role_settings UPDATE mentioning view_teams touches teams/team_members/locations', async () => {
  const pg = fakePg({ callerRole: 'full_admin' });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'UPDATE', table_name: 'role_settings',
      payload: { role: 'office_manager', permission_overrides: { view_teams: false }, updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE teams SET updated_at = NOW()')), 'teams touched');
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE team_members SET updated_at = NOW()')), 'team_members touched');
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE locations SET updated_at = NOW()')), 'locations touched');
  await app.close();
});

test('push: role_settings UPDATE mentioning view_locations touches teams/team_members/locations', async () => {
  const pg = fakePg({ callerRole: 'full_admin' });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'UPDATE', table_name: 'role_settings',
      payload: { role: 'office_manager', permission_overrides: { view_locations: true }, updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE teams SET updated_at = NOW()')), 'teams touched');
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE team_members SET updated_at = NOW()')), 'team_members touched');
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE locations SET updated_at = NOW()')), 'locations touched');
  await app.close();
});

test('push: role_settings UPDATE touching an UNRELATED permission does NOT touch teams/team_members/locations', async () => {
  const pg = fakePg({ callerRole: 'full_admin' });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'UPDATE', table_name: 'role_settings',
      payload: { role: 'office_manager', permission_overrides: { edit_inventory: true }, updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(!pg.queries.some(q => q.sql.includes('UPDATE teams SET updated_at = NOW()')), 'teams NOT touched');
  assert.ok(!pg.queries.some(q => q.sql.includes('UPDATE team_members SET updated_at = NOW()')), 'team_members NOT touched');
  assert.ok(!pg.queries.some(q => q.sql.includes('UPDATE locations SET updated_at = NOW()')), 'locations NOT touched');
  await app.close();
});

test('push: users UPDATE mentioning view_teams in permission_overrides touches teams/team_members/locations', async () => {
  const pg = fakePg({
    callerRole: 'full_admin',
    targetUsers: { 'target-user-1': { role: 'construction_crew', active: true } },
  });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'UPDATE', table_name: 'users',
      payload: { id: 'target-user-1', permission_overrides: { view_teams: true }, updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE teams SET updated_at = NOW()')), 'teams touched');
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE team_members SET updated_at = NOW()')), 'team_members touched');
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE locations SET updated_at = NOW()')), 'locations touched');
  await app.close();
});

test('push: users UPDATE mentioning view_locations (JSON-string form) touches teams/team_members/locations', async () => {
  // The mobile outbox stores permission_overrides as a stringified JSON blob —
  // touchTeamsAndLocationsIfViewPermsChanged must parse it, not just object-check.
  const pg = fakePg({
    callerRole: 'full_admin',
    targetUsers: { 'target-user-2': { role: 'construction_crew', active: true } },
  });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'UPDATE', table_name: 'users',
      payload: { id: 'target-user-2', permission_overrides: JSON.stringify({ view_locations: false }), updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE teams SET updated_at = NOW()')), 'teams touched');
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE team_members SET updated_at = NOW()')), 'team_members touched');
  assert.ok(pg.queries.some(q => q.sql.includes('UPDATE locations SET updated_at = NOW()')), 'locations touched');
  await app.close();
});

test('push: users UPDATE with no permission_overrides key at all does NOT touch teams/team_members/locations', async () => {
  const pg = fakePg({
    callerRole: 'full_admin',
    targetUsers: { 'target-user-3': { role: 'construction_crew', active: true } },
  });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{
      operation: 'UPDATE', table_name: 'users',
      payload: { id: 'target-user-3', name: 'Renamed', updated_at: NOW },
    }]),
  });
  const body = res.json() as { ok: string[]; conflicts: unknown[] };
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(!pg.queries.some(q => q.sql.includes('UPDATE teams SET updated_at = NOW()')), 'teams NOT touched');
  assert.ok(!pg.queries.some(q => q.sql.includes('UPDATE team_members SET updated_at = NOW()')), 'team_members NOT touched');
  assert.ok(!pg.queries.some(q => q.sql.includes('UPDATE locations SET updated_at = NOW()')), 'locations NOT touched');
  await app.close();
});
