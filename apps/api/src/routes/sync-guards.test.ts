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
  // field-crew (#122)
  subteams: ['id', 'team_id', 'name', 'active', 'created_at', 'updated_at'],
  vehicles: ['location_id', 'truck_mount', 'water_state', 'model', 'model_id', 'notes', 'updated_at'],
  vehicle_checkouts: ['id', 'vehicle_location_id', 'user_id', 'job_id', 'checked_out_at', 'checked_in_at', 'created_at', 'updated_at'],
  locker_access: ['location_id', 'user_id', 'granted_by', 'created_at', 'updated_at'],
  unit_access: ['location_id', 'user_id', 'can_view', 'can_add', 'can_remove', 'can_move', 'can_edit_details', 'can_grant', 'granted_by', 'created_at', 'updated_at'],
  on_call_shifts: ['id', 'subteam_id', 'week_start', 'created_by', 'created_at', 'updated_at'],
  locations: ['id', 'name', 'type', 'type_id', 'owner_user_id', 'active', 'updated_at'],
};

interface FakePgOpts {
  messageSender?: string;
  callerRole?: string;
  /** resolveTeamAuthority: is the caller a manager of the queried team? */
  isManager?: boolean;
  /** subteams UPDATE/DELETE team lookup (SELECT team_id FROM subteams). */
  subteamTeamId?: string;
  /** #84 flag row value ('1' enables); absent → no row (off). */
  crewAddVehicle?: boolean;
  /** locker_access guard: locations.owner_user_id (null = ownerless row). */
  lockerOwner?: string | null;
  /** locker_access guard: location row missing entirely. */
  lockerMissing?: boolean;
  /** vehicle_checkouts UPDATE pre-read row; absent → no row. */
  checkoutRow?: { user_id: string | null; checked_in_at: string | null };
  /** ADJUST locker guard facts; absent → location row missing. */
  adjustLoc?: { type: string | null; is_owner: boolean; has_grant: boolean; shares_team: boolean };
}

// Dispatching fake pg (auth-demo.test.ts pattern). Records every query so the
// tests can assert what SQL actually ran. The media stub HONORS the scope built
// into the query TEXT — an unscoped media query returns everything, so a
// missing mediaScopeSql would surface as a leak in the assertions.
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
      // resolveTeamAuthority (subteams per-row guard) — selects tm.is_manager.
      if (sql.includes('COALESCE(tm.is_manager')) {
        return { rows: [{ role: opts.callerRole ?? 'full_admin', permission_overrides: null, role_overrides: null, is_manager: opts.isManager ?? false }] };
      }
      // resolveCaller — the only query that selects u.is_test.
      if (sql.includes('u.is_test')) {
        return { rows: [{ role: opts.callerRole ?? 'full_admin', permission_overrides: null, role_overrides: null, is_test: false }] };
      }
      if (sql.includes(`key = 'maintenance_mode'`)) return { rows: [] };
      if (sql.includes(`key = 'crew_add_vehicle_enabled'`)) {
        return { rows: opts.crewAddVehicle ? [{ value: '1' }] : [] };
      }
      // subteams UPDATE/DELETE team resolution.
      if (sql.includes('SELECT team_id FROM subteams')) {
        return { rows: opts.subteamTeamId ? [{ team_id: opts.subteamTeamId }] : [] };
      }
      // locker_access owner guard.
      if (sql.includes('SELECT owner_user_id FROM locations')) {
        return { rows: opts.lockerMissing ? [] : [{ owner_user_id: opts.lockerOwner ?? null }] };
      }
      // vehicle_checkouts UPDATE pre-read.
      if (sql.includes('SELECT user_id, checked_in_at FROM vehicle_checkouts')) {
        return { rows: opts.checkoutRow ? [opts.checkoutRow] : [] };
      }
      // ADJUST locker guard fact query (owner/grant/team-mate facts in one row).
      if (sql.includes('shares_team')) {
        return { rows: opts.adjustLoc ? [opts.adjustLoc] : [] };
      }
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

// ── #38: users INSERT enforces the role-assign tier guard (no existing row) ──

test('push: a users INSERT minting a role above the caller is a permanent rejection and never runs SQL', async () => {
  // office_manager holds manage_users but NOT manage_roles_permissions and sits
  // at tier 3 — it must not be able to INSERT a fresh full_admin (tier 5 apex).
  const pg = fakePg({ callerRole: 'office_manager' });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([
      { operation: 'INSERT', table_name: 'users', payload: { id: 'brand-new-uuid', role: 'full_admin', active: true } },
    ]),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: string[]; conflicts: Array<{ id: string; error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 1);
  // Must read as permanent to the mobile engine, or the entry wedges the outbox.
  assert.match(body.conflicts[0].error, PERMANENT);
  // The guard rejected BEFORE applyEntry — no apex admin was ever minted.
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO users')), 'a forbidden role INSERT must never reach SQL');
  await app.close();
});

test('push: a users INSERT at or below the caller\'s tier is allowed past the role-assign guard', async () => {
  // office_manager (tier 3) INSERTing a tier-1 crew member is within its authority;
  // the role-assign guard must NOT reject it (it reaches the write path).
  const pg = fakePg({ callerRole: 'office_manager' });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([
      { operation: 'INSERT', table_name: 'users', payload: { id: 'brand-new-uuid', role: 'construction_crew', active: true } },
    ]),
  });
  const body = res.json() as { conflicts: Array<{ id: string; error: string }> };
  // No role-assign rejection for an at-or-below role.
  assert.ok(!body.conflicts.some(c => /cannot assign a role/i.test(c.error)),
    'a role at or below the caller\'s tier must clear the assign guard');
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

// ── #123: subteams per-row team-authority guard ──────────────────────────────

type PushResult = { ok: string[]; conflicts: Array<{ id: string; error: string }> };

async function push(pg: ReturnType<typeof fakePg>, entries: Parameters<typeof pushBody>[0]): Promise<PushResult> {
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody(entries) });
  assert.equal(res.statusCode, 200);
  await app.close();
  return res.json() as PushResult;
}

test('subteams: a caller without manage_teams is rejected at the table gate (fail closed)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'subteams', payload: { id: 'st1', team_id: 'team-1', name: 'TV/FT' } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.match(body.conflicts[0].error, /manage_teams/);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO subteams')));
});

test('subteams: a manage_teams holder who does NOT manage that team is a permanent rejection', async () => {
  // production_manager holds manage_teams (tier 2) but is not org authority —
  // exactly who the per-row guard exists for.
  const pg = fakePg({ callerRole: 'production_manager', isManager: false });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'subteams', payload: { id: 'st1', team_id: 'team-1', name: 'TV/FT' } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO subteams')), 'the write must never reach SQL');
});

test('subteams: the team\'s own manager may create/update crews', async () => {
  const pg = fakePg({ callerRole: 'production_manager', isManager: true });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'subteams', payload: { id: 'st1', team_id: 'team-1', name: 'TV/FT', active: true } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(pg.queries.some(q => q.sql.includes('INSERT INTO subteams')));
});

test('subteams: org authority (full_admin) is allowed without being a member', async () => {
  const pg = fakePg({ callerRole: 'full_admin', isManager: false });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'subteams', payload: { id: 'st1', team_id: 'team-1', name: 'Renamed' } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
});

test('subteams: a payload without team_id resolves it from the row; an unresolvable subteam fails closed', async () => {
  // DELETE carries only the key — team_id comes from the DB row.
  const okPg = fakePg({ callerRole: 'production_manager', isManager: true, subteamTeamId: 'team-1' });
  const okBody = await push(okPg, [
    { operation: 'DELETE', table_name: 'subteams', payload: { id: 'st1' } },
  ]);
  assert.deepEqual(okBody.ok, ['e1']);
  assert.ok(okPg.queries.some(q => q.sql.includes('SELECT team_id FROM subteams')));
  // No such row → permanent rejection (never an open write).
  const missingPg = fakePg({ callerRole: 'production_manager', isManager: true });
  const missingBody = await push(missingPg, [
    { operation: 'DELETE', table_name: 'subteams', payload: { id: 'st-ghost' } },
  ]);
  assert.deepEqual(missingBody.ok, []);
  assert.match(missingBody.conflicts[0].error, PERMANENT);
});

// ── #126: locker_access owner-or-org-authority guard ─────────────────────────

test('locker_access: the location OWNER may grant, and granted_by is forced to the caller', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', lockerOwner: CALLER });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'locker_access', payload: { location_id: 'loc-1', user_id: OTHER, granted_by: 'forged-id', created_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO locker_access'));
  assert.ok(ins, 'the grant must reach SQL');
  assert.ok(ins!.params.includes(CALLER), 'granted_by must be the authenticated caller');
  assert.ok(!ins!.params.includes('forged-id'), 'a forged granted_by must not survive');
});

test('locker_access: a non-owner without org authority is a permanent rejection (grant and revoke)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', lockerOwner: OTHER });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'locker_access', payload: { location_id: 'loc-1', user_id: CALLER } },
    { operation: 'DELETE', table_name: 'locker_access', payload: { location_id: 'loc-1', user_id: OTHER } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 2);
  for (const c of body.conflicts) assert.match(c.error, PERMANENT);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO locker_access') || q.sql.includes('DELETE FROM locker_access')));
});

test('locker_access: a grant against a missing location fails closed (permanent)', async () => {
  const pg = fakePg({ callerRole: 'full_admin', lockerMissing: true });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'locker_access', payload: { location_id: 'loc-ghost', user_id: OTHER } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
});

test('locker_access: org authority may manage access to any locker', async () => {
  const pg = fakePg({ callerRole: 'full_admin', lockerOwner: OTHER });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'locker_access', payload: { location_id: 'loc-1', user_id: CALLER } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
});

// ── #122 Phase A1: unit_access rides the same owner-or-org-authority guard ───

test('unit_access: the unit OWNER may grant, and granted_by is forced to the caller', async () => {
  const pg = fakePg({ callerRole: 'mitigation_technician', lockerOwner: CALLER });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'unit_access', payload: { location_id: 'loc-1', user_id: OTHER, can_view: true, can_add: true, can_remove: false, can_move: false, can_edit_details: false, can_grant: false, granted_by: OTHER, created_at: NOW, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO unit_access'));
  assert.ok(ins && ins.params.includes(CALLER), 'granted_by forced to caller');
});

test('unit_access: a non-owner without org authority is a permanent rejection', async () => {
  const pg = fakePg({ callerRole: 'mitigation_technician', lockerOwner: OTHER });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'unit_access', payload: { location_id: 'loc-1', user_id: CALLER, can_view: true, created_at: NOW, updated_at: NOW } },
    { operation: 'DELETE', table_name: 'unit_access', payload: { location_id: 'loc-1', user_id: OTHER } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 2);
  for (const c of body.conflicts) assert.match(c.error, PERMANENT);
});

test('unit_access: org authority may manage access to any unit', async () => {
  const pg = fakePg({ callerRole: 'full_admin', lockerOwner: OTHER });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'unit_access', payload: { location_id: 'loc-1', user_id: CALLER, can_view: true, can_grant: true, created_at: NOW, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
});

// ── #125: vehicle_checkouts attribution + close-only takeover ────────────────

test('vehicle_checkouts INSERT: user_id is forced to the caller (cannot check out as someone else)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'vehicle_checkouts', payload: { id: 'vc1', vehicle_location_id: 'loc-1', user_id: OTHER, checked_out_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO vehicle_checkouts'));
  assert.ok(ins, 'the checkout must reach SQL');
  assert.ok(ins!.params.includes(CALLER), 'user_id must be the authenticated caller');
  assert.ok(!ins!.params.includes(OTHER), 'the forged holder must not survive');
});

test('vehicle_checkouts UPDATE: the holder may edit their own session (add a job later)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', checkoutRow: { user_id: CALLER, checked_in_at: null } });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'vehicle_checkouts', payload: { id: 'vc1', job_id: 'job-9' } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(pg.queries.some(q => q.sql.startsWith('UPDATE vehicle_checkouts')));
});

test('vehicle_checkouts UPDATE: warn-and-take-over — a stranger may CLOSE an open session (checked_in_at only)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', checkoutRow: { user_id: OTHER, checked_in_at: null } });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'vehicle_checkouts', payload: { id: 'vc1', checked_in_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(pg.queries.some(q => q.sql.startsWith('UPDATE vehicle_checkouts')));
});

test('vehicle_checkouts UPDATE: a stranger touching anything BEYOND checked_in_at is a permanent rejection', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', checkoutRow: { user_id: OTHER, checked_in_at: null } });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'vehicle_checkouts', payload: { id: 'vc1', checked_in_at: NOW, job_id: 'job-9' } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.ok(!pg.queries.some(q => q.sql.startsWith('UPDATE vehicle_checkouts')), 'the takeover-plus-edit must never reach SQL');
});

test('vehicle_checkouts UPDATE: a stranger cannot re-close (or reopen) an already-closed session', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', checkoutRow: { user_id: OTHER, checked_in_at: NOW } });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'vehicle_checkouts', payload: { id: 'vc1', checked_in_at: '2026-07-15T00:00:00.000Z' } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
});

test('vehicle_checkouts UPDATE: manage_teams may edit any session', async () => {
  const pg = fakePg({ callerRole: 'production_manager', checkoutRow: { user_id: OTHER, checked_in_at: null } });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'vehicle_checkouts', payload: { id: 'vc1', job_id: 'job-9' } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
});

// ── #126: hard locker enforcement on ADJUST ──────────────────────────────────

const LOCKER_DENY = { type: 'Locker', is_owner: false, has_grant: false, shares_team: false };

test('ADJUST: a negative delta from a locker by a non-grantee is a permanent rejection and never touches stock', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', adjustLoc: LOCKER_DENY });
  const body = await push(pg, [
    { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'item-1', location_id: 'loc-1', delta: -2 } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.match(body.conflicts[0].error, /locker/i);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO stock_by_location')), 'stock must never move');
});

test('ADJUST: owner / grantee / owner\'s team-mate may take from the locker', async () => {
  for (const facts of [
    { ...LOCKER_DENY, is_owner: true },
    { ...LOCKER_DENY, has_grant: true },
    { ...LOCKER_DENY, shares_team: true },
  ]) {
    const pg = fakePg({ callerRole: 'construction_crew', adjustLoc: facts });
    const body = await push(pg, [
      { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'item-1', location_id: 'loc-1', delta: -2 } },
    ]);
    assert.deepEqual(body.ok, ['e1'], `facts ${JSON.stringify(facts)} must be allowed`);
    assert.ok(pg.queries.some(q => q.sql.includes('INSERT INTO stock_by_location')));
  }
});

test('ADJUST: org authority (tier 3+) bypasses the locker guard without a lookup', async () => {
  const pg = fakePg({ callerRole: 'full_admin', adjustLoc: LOCKER_DENY });
  const body = await push(pg, [
    { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'item-1', location_id: 'loc-1', delta: -2 } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(!pg.queries.some(q => q.sql.includes('shares_team')), 'the locker lookup must be skipped for org authority');
});

test('ADJUST: positive deltas into a locker stay open (restocking is not gated)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', adjustLoc: LOCKER_DENY });
  const body = await push(pg, [
    { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'item-1', location_id: 'loc-1', delta: 3 } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
});

test('ADJUST: non-locker locations are unaffected by the guard', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', adjustLoc: { ...LOCKER_DENY, type: 'Shop' } });
  const body = await push(pg, [
    { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'item-1', location_id: 'loc-2', delta: -5 } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
});

// ── #84: crew add-a-vehicle flag path on locations INSERT ────────────────────

test('locations INSERT by a crew role: rejected while the flag is off (permanent)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', crewAddVehicle: false });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'loc-new', name: 'My Van', type: 'Vehicle', active: true } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.match(body.conflicts[0].error, /manage_locations/);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO locations')));
});

test('locations INSERT by a crew role: allowed when crew_add_vehicle_enabled=1 AND the row is a Vehicle', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', crewAddVehicle: true });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'loc-new', name: 'My Van', type: 'Vehicle', active: true } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(pg.queries.some(q => q.sql.includes('INSERT INTO locations')));
});

test('locations INSERT by a crew role: the flag does NOT open non-Vehicle locations', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', crewAddVehicle: true });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'loc-new', name: 'Sneaky Warehouse', type: 'Warehouse', active: true } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
});

// ── #128: on_call_shifts upserts on week_start ───────────────────────────────

test('on_call_shifts INSERT upserts on week_start (one crew per week; reassignment replaces)', async () => {
  const pg = fakePg({ callerRole: 'full_admin' });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'on_call_shifts', payload: { id: 'oc1', subteam_id: 'st1', week_start: '2026-07-20', created_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO on_call_shifts'));
  assert.ok(ins, 'the assignment must reach SQL');
  assert.match(ins!.sql, /ON CONFLICT \(week_start\) DO UPDATE/, 'must upsert on the WEEK, not the row id');
});

test('on_call_shifts writes require manage_teams (crew cannot self-assign the on-call week)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'on_call_shifts', payload: { id: 'oc1', subteam_id: 'st1', week_start: '2026-07-20' } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.match(body.conflicts[0].error, /manage_teams/);
});
