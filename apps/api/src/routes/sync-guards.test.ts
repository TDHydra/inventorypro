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
// team-a: caller's own team (shared with teammate-1); team-b: a different team
// (not-my-teammate is on it, caller is not) — models the #87/#148 'team'
// pool-share audience (uploader's teammates only).
const TEAM_MEMBERS: Record<string, string[]> = {
  'team-a': [CALLER, 'teammate-1'],
  'team-b': ['not-my-teammate'],
};
// #204: one location row carrying every BASE + SENSITIVE column, so a test
// can assert exactly which keys survive the projection for a given
// canViewLocations. owner_user_id lives in BASE (see syncPolicy.ts) —
// present regardless of view_locations.
const LOCATION_ROWS = [
  {
    id: 'loc-1', name: 'Main Warehouse', parent_id: null, color: null, icon: null,
    active: true, has_shelves: false, type: 'Shop', type_id: null, updated_at: NOW,
    owner_user_id: 'owner-user-id', latitude: 39.5, longitude: -98.35, subareas_require_owner: false,
  },
];
// #204: team_members fixture reusing the TEAM_MEMBERS roster above — CALLER
// and teammate-1 share team-a; not-my-teammate is on the unrelated team-b.
const TEAM_MEMBER_ROWS = [
  { team_id: 'team-a', user_id: CALLER, team_permission_overrides: {}, added_by: null, joined_at: NOW, is_manager: false, updated_at: NOW, subteam_id: null, subteam_role: null },
  { team_id: 'team-a', user_id: 'teammate-1', team_permission_overrides: {}, added_by: null, joined_at: NOW, is_manager: false, updated_at: NOW, subteam_id: null, subteam_role: null },
  { team_id: 'team-b', user_id: 'not-my-teammate', team_permission_overrides: {}, added_by: null, joined_at: NOW, is_manager: false, updated_at: NOW, subteam_id: null, subteam_role: null },
];
const MEDIA_ROWS = [
  { id: 'media-item', entity_type: 'item', entity_id: 'item-1' },
  { id: 'media-msg-mine', entity_type: 'message', entity_id: 'msg-mine' },
  { id: 'media-msg-foreign', entity_type: 'message', entity_id: 'msg-foreign' },
  { id: 'media-pool-mine', entity_type: 'pool', uploaded_by: CALLER, audience: 'users', audience_user_ids: '["other-user"]' },
  { id: 'media-pool-everyone', entity_type: 'pool', uploaded_by: 'stranger', audience: 'everyone', audience_user_ids: null },
  { id: 'media-pool-team', entity_type: 'pool', uploaded_by: 'teammate-1', audience: 'team', audience_user_ids: null },
  { id: 'media-pool-otherteam', entity_type: 'pool', uploaded_by: 'not-my-teammate', audience: 'team', audience_user_ids: null },
  { id: 'media-pool-listed', entity_type: 'pool', uploaded_by: 'stranger', audience: 'users', audience_user_ids: `["${CALLER}"]` },
  { id: 'media-pool-notlisted', entity_type: 'pool', uploaded_by: 'stranger', audience: 'users', audience_user_ids: '["someone-else"]' },
];

// Boot-time column introspection result — just the tables these tests write to.
const COLUMNS: Record<string, string[]> = {
  app_config: ['key', 'value', 'updated_at'],
  role_settings: ['role', 'min_pin_length', 'permission_overrides', 'color', 'dashboard_preset_id', 'updated_at', 'idle_reauth_minutes'],
  messages: ['id', 'conversation_id', 'sender_id', 'body', 'urgency', 'created_at', 'updated_at', 'edited_at', 'deleted_at'],
  // field-crew (#122)
  subteams: ['id', 'team_id', 'name', 'active', 'created_at', 'updated_at'],
  vehicles: ['location_id', 'truck_mount', 'water_state', 'model', 'model_id', 'notes', 'updated_at', 'water_tank', 'waste_tank', 'checkout_locked', 'debris_option', 'debris_level', 'open_checkout', 'locked_by'],
  vehicle_checkouts: ['id', 'vehicle_location_id', 'user_id', 'job_id', 'checked_out_at', 'checked_in_at', 'created_at', 'updated_at'],
  locker_access: ['location_id', 'user_id', 'granted_by', 'created_at', 'updated_at'],
  unit_access: ['location_id', 'user_id', 'can_view', 'can_add', 'can_remove', 'can_move', 'can_edit_details', 'can_grant', 'granted_by', 'created_at', 'updated_at'],
  on_call_shifts: ['id', 'subteam_id', 'week_start', 'created_by', 'created_at', 'updated_at'],
  on_call_coverage: ['id', 'date_start', 'date_end', 'user_off', 'covering_user', 'note', 'created_by', 'created_at', 'updated_at'],
  locations: ['id', 'name', 'type', 'type_id', 'owner_user_id', 'active', 'updated_at'],
  // #162 team-scoped unit inventory
  stock_by_location: ['item_id', 'location_id', 'quantity', 'updated_at'],
  equipment_units: ['id', 'item_id', 'asset_tag', 'serial_number', 'status', 'current_location_id', 'current_job_id', 'notes', 'created_at', 'updated_at'],
  // #178 v1: immutable troubleshooting-steps log.
  repair_steps: ['id', 'repair_id', 'action', 'result', 'created_by', 'created_at', 'updated_at'],
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
  /** unit_access guard facts (single fact query, aliased manages_owner_team). */
  unitOwner?: string | null;
  unitLocMissing?: boolean;
  granteeRole?: string | null;
  managesOwnerTeam?: boolean;
  /** vehicle_checkouts UPDATE pre-read row; absent → no row. */
  checkoutRow?: { user_id: string | null; checked_in_at: string | null };
  /** #176 vehicles lock/share guard facts (single fact query, aliased
   *  shares_owner_team); absent field → unowned/unlocked/no-team-share defaults. */
  vehicleFacts?: {
    ownerUserId?: string | null;
    checkoutLocked?: boolean;
    openCheckout?: boolean;
    lockedBy?: string | null;
    lockedByRole?: string | null;
    sharesOwnerTeam?: boolean;
  };
  /** #176: the vehicle's location row is missing entirely (fails closed). */
  vehicleLocMissing?: boolean;
  /** ADJUST locker guard facts; absent → location row missing. owner_user_id
   *  feeds the #162 team-unit guard (undefined → ownerless → passes it). */
  adjustLoc?: { type: string | null; is_owner: boolean; has_grant: boolean; shares_team: boolean; owner_user_id?: string | null };
  /** #162: per-location unit facts, keyed by location id (params[0]); takes
   *  precedence over adjustLoc so a test can give old/new locations different
   *  ownership. Missing key → location row missing. */
  unitLocById?: Record<string, { type: string | null; owner_user_id?: string | null; is_owner?: boolean; has_grant?: boolean; shares_team?: boolean } | null>;
  /** #162: equipment_units old-row location for the move-OUT lookup. */
  equipOldLocation?: string | null;
  /** resolveCaller permission_overrides (e.g. a manage_other_team_inventory user grant). */
  callerOverrides?: Record<string, boolean> | null;
  /** Vehicle name-uniqueness lookup: existing active Vehicle with same normalized name. */
  vehicleDupSurvivor?: string;
  /** parent-type lookup for the no-sub-areas guard. */
  parentType?: string;
  /** #122 C: active-PM roster for the on_call fan-out (resolveRoleRecipients). */
  pmRoster?: string[];
  /** #235: maintenance_mode flag row ('1' freezes writes); absent → off. */
  maintenanceOn?: boolean;
  /** applyEntry failure injection: throw on any sql containing this string. */
  failOn?: string;
  /** Postgres error code stamped on the injected failure (e.g. '23503'). */
  failCode?: string;
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
      // Failure injection for the applyEntry catch tests — a raw DB error whose
      // message must never reach the client verbatim.
      if (opts.failOn && sql.includes(opts.failOn)) {
        const e = new Error('insert or update on table "stock_by_location" violates foreign key constraint "stock_by_location_location_id_fkey"');
        (e as Error & { code?: string }).code = opts.failCode;
        throw e;
      }
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
        return { rows: [{ role: opts.callerRole ?? 'full_admin', permission_overrides: opts.callerOverrides ?? null, role_overrides: null, is_test: false }] };
      }
      // #162: equipment_units old-location pre-read for the move-OUT check.
      if (sql.includes('SELECT current_location_id FROM equipment_units')) {
        return { rows: opts.equipOldLocation !== undefined ? [{ current_location_id: opts.equipOldLocation }] : [] };
      }
      // #122 C fan-out: getNotifyConfig reads app_config (enabled), claimEvent
      // wins the dedup ledger, resolveRoleRecipients returns the PM roster, and
      // resolveRecipients' final active-only pass echoes the ids back as active.
      if (sql.includes('FROM app_config WHERE key = ANY')) {
        return { rows: [{ key: 'notify_enabled', value: '1' }] };
      }
      if (sql.includes('INSERT INTO notification_dedup')) {
        return { rows: [{ event_key: params[0] }] }; // newly inserted → claim won
      }
      if (sql.includes('FROM users WHERE role = ANY')) {
        return { rows: (opts.pmRoster ?? []).map(id => ({ id })) };
      }
      if (sql.includes('id = ANY') && sql.includes('NOT is_test')) {
        return { rows: (params[0] as string[]).map(id => ({ id })) };
      }
      if (sql.includes(`key = 'maintenance_mode'`)) {
        return { rows: opts.maintenanceOn ? [{ value: '1' }] : [] };
      }
      if (sql.includes(`key = 'crew_add_vehicle_enabled'`)) {
        return { rows: opts.crewAddVehicle ? [{ value: '1' }] : [] };
      }
      // subteams UPDATE/DELETE team resolution.
      if (sql.includes('SELECT team_id FROM subteams')) {
        return { rows: opts.subteamTeamId ? [{ team_id: opts.subteamTeamId }] : [] };
      }
      // #129 vehicle name-uniqueness lookup.
      if (sql.includes('LOWER(TRIM(name))')) {
        return { rows: opts.vehicleDupSurvivor ? [{ id: opts.vehicleDupSurvivor }] : [] };
      }
      // no-sub-areas guard parent lookup.
      if (sql.includes('SELECT type FROM locations')) {
        return { rows: opts.parentType ? [{ type: opts.parentType }] : [] };
      }
      // #176 vehicles lock/share guard fact query.
      if (sql.includes('shares_owner_team')) {
        if (opts.vehicleLocMissing) return { rows: [] };
        const vf = opts.vehicleFacts ?? {};
        return {
          rows: [{
            owner_user_id: vf.ownerUserId ?? null,
            checkout_locked: vf.checkoutLocked ?? false,
            open_checkout: vf.openCheckout ?? false,
            locked_by: vf.lockedBy ?? null,
            shares_owner_team: vf.sharesOwnerTeam ?? false,
            locked_by_role: vf.lockedByRole ?? null,
          }],
        };
      }
      // unit_access guard fact query (#122 Phase B).
      if (sql.includes('manages_owner_team')) {
        return { rows: opts.unitLocMissing ? [] : [{
          owner_user_id: opts.unitOwner ?? null,
          grantee_role: opts.granteeRole ?? 'mitigation_technician',
          manages_owner_team: opts.managesOwnerTeam ?? false,
        }] };
      }
      // locker_access owner guard.
      if (sql.includes('SELECT owner_user_id FROM locations')) {
        return { rows: opts.lockerMissing ? [] : [{ owner_user_id: opts.lockerOwner ?? null }] };
      }
      // vehicle_checkouts UPDATE pre-read.
      if (sql.includes('SELECT user_id, checked_in_at FROM vehicle_checkouts')) {
        return { rows: opts.checkoutRow ? [opts.checkoutRow] : [] };
      }
      // ADJUST locker guard + #162 unit-ownership fact queries (both select a
      // shares_team column). unitLocById dispatches per location id when a test
      // needs old/new locations with different ownership.
      if (sql.includes('shares_team')) {
        if (opts.unitLocById) {
          const row = opts.unitLocById[String(params[0])];
          return { rows: row ? [row] : [] };
        }
        return { rows: opts.adjustLoc ? [opts.adjustLoc] : [] };
      }
      // messages-UPDATE sender guard lookup.
      if (sql.includes('SELECT sender_id FROM messages')) {
        return { rows: opts.messageSender ? [{ sender_id: opts.messageSender }] : [] };
      }
      // #204: the real /sync/full and /sync/pull locations SELECT (column-level
      // redaction — never row-scoped). More specific existing locations checks
      // above (parent-type guard, locker_access owner guard) already returned
      // by the time execution reaches here, so this only matches the actual
      // projection query. Trim each fixture row down to exactly the requested
      // column list, mirroring what real Postgres would return.
      if (/^SELECT .+ FROM locations\b/.test(sql)) {
        const cols = sql.match(/^SELECT (.+?) FROM locations\b/)![1].split(',').map(s => s.trim());
        return {
          rows: LOCATION_ROWS.map(r => {
            const out: Record<string, unknown> = {};
            for (const c of cols) out[c] = (r as Record<string, unknown>)[c];
            return out;
          }),
        };
      }
      // #204: the real /sync/full and /sync/pull team_members SELECT (row-level
      // scoping — always '*' column-wise, no projection split). Distinguishes
      // the self-row carve-out (`user_id = $N` alone) from the normal
      // any-of-my-teams scope (`team_id IN (SELECT team_id FROM team_members
      // WHERE user_id = $N)`) from unscoped (canSeeAllTeams, no WHERE at all).
      if (/^SELECT .+ FROM team_members\b/.test(sql)) {
        const teamsScoped = sql.includes('team_id IN (SELECT team_id FROM team_members');
        const selfOnly = !teamsScoped && /\buser_id = \$\d+\b/.test(sql);
        if (selfOnly) return { rows: TEAM_MEMBER_ROWS.filter(r => r.user_id === CALLER) };
        if (teamsScoped) {
          const myTeams = Object.keys(TEAM_MEMBERS).filter(t => TEAM_MEMBERS[t].includes(CALLER));
          return { rows: TEAM_MEMBER_ROWS.filter(r => myTeams.includes(r.team_id)) };
        }
        return { rows: TEAM_MEMBER_ROWS };
      }
      if (sql.includes('FROM media')) {
        const msgScoped = sql.includes(`entity_type != 'message'`)
          && sql.includes('conversation_participants WHERE user_id =');
        // #87/#148: pool-share scoping fragment.
        const poolScoped = sql.includes(`entity_type != 'pool'`);
        if (!msgScoped && !poolScoped) return { rows: MEDIA_ROWS };
        // Emulate the predicate for the caller-id param (last positional in
        // both /pull ($2) and /full ($3)).
        const uid = String(params[params.length - 1]);
        const teamsOf = (userId: string) =>
          Object.keys(TEAM_MEMBERS).filter(t => TEAM_MEMBERS[t].includes(userId));
        const sharesTeamWith = (otherUserId: string) => {
          const myTeams = teamsOf(uid);
          return teamsOf(otherUserId).some(t => myTeams.includes(t));
        };
        return {
          rows: MEDIA_ROWS.filter(m => {
            const msgOk = !msgScoped || m.entity_type !== 'message'
              || (PARTICIPANTS[MESSAGE_CONV[m.entity_id as keyof typeof MESSAGE_CONV]] ?? []).includes(uid);
            const poolOk = !poolScoped || m.entity_type !== 'pool'
              || m.uploaded_by === uid
              || m.audience === 'everyone'
              || (m.audience === 'team' && sharesTeamWith(m.uploaded_by as string))
              || (m.audience === 'users' && typeof m.audience_user_ids === 'string' && m.audience_user_ids.includes(uid));
            return msgOk && poolOk;
          }),
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
  // media-msg-foreign stays excluded; the visible pool shares (#87/#148) now
  // also appear alongside the always-unscoped item media.
  assert.deepEqual(media.map(r => r.id).sort(),
    ['media-item', 'media-msg-mine', 'media-pool-everyone', 'media-pool-listed', 'media-pool-mine', 'media-pool-team']);
  await app.close();
});

test('full: the media page is scoped the same way as the incremental pull', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'GET', url: '/sync/full?table=media' });
  assert.equal(res.statusCode, 200);
  const { rows } = res.json() as { rows: Array<{ id: string }> };
  assert.deepEqual(rows.map(r => r.id).sort(),
    ['media-item', 'media-msg-mine', 'media-pool-everyone', 'media-pool-listed', 'media-pool-mine', 'media-pool-team']);
  await app.close();
});

// ── #87/#148: media pull scoping for pool shares ──────────────────────────────

test('pull: pool media scoped to uploader/everyone/team/listed users', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'GET', url: '/sync/pull?since=2020-01-01T00:00:00.000Z' });
  assert.equal(res.statusCode, 200);
  const media = (res.json() as Record<string, { rows: Array<{ id: string }> }>).media.rows;
  assert.deepEqual(media.map(r => r.id).sort(),
    ['media-item', 'media-msg-mine', 'media-pool-everyone', 'media-pool-listed', 'media-pool-mine', 'media-pool-team']);
  await app.close();
});

test('full: pool media scoped identically', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'GET', url: '/sync/full?table=media' });
  assert.equal(res.statusCode, 200);
  const { rows } = res.json() as { rows: Array<{ id: string }> };
  assert.deepEqual(rows.map(r => r.id).sort(),
    ['media-item', 'media-msg-mine', 'media-pool-everyone', 'media-pool-listed', 'media-pool-mine', 'media-pool-team']);
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

// ── #122 Phase B: unit_access owner/manager/PM guard ─────────────────────────

const GRANT_ROW = {
  location_id: 'loc-1', user_id: OTHER, can_view: true, can_add: true, can_remove: true,
  can_move: true, can_edit_details: false, can_grant: false, granted_by: 'forged-id',
  created_at: NOW, updated_at: NOW,
};

test('unit_access: the unit OWNER may grant, and granted_by is forced to the caller', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', unitOwner: CALLER });
  const body = await push(pg, [{ operation: 'INSERT', table_name: 'unit_access', payload: { ...GRANT_ROW } }]);
  assert.deepEqual(body.ok, ['e1']);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO unit_access'));
  assert.ok(ins, 'the grant must reach SQL');
  assert.ok(ins!.params.includes(CALLER), 'granted_by must be the authenticated caller');
  assert.ok(!ins!.params.includes('forged-id'), 'a forged granted_by must not survive');
});

test('unit_access: a production_manager may edit grants for a tier-1 grantee on any unit', async () => {
  const pg = fakePg({ callerRole: 'production_manager', unitOwner: OTHER, granteeRole: 'mitigation_technician' });
  const body = await push(pg, [{ operation: 'UPDATE', table_name: 'unit_access', payload: { ...GRANT_ROW, can_remove: false } }]);
  assert.deepEqual(body.ok, ['e1']);
});

test('unit_access: a production_manager may NOT touch a full_admin grantee (permanent)', async () => {
  const pg = fakePg({ callerRole: 'production_manager', unitOwner: OTHER, granteeRole: 'full_admin' });
  const body = await push(pg, [{ operation: 'INSERT', table_name: 'unit_access', payload: { ...GRANT_ROW } }]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
});

test('unit_access: a manager of a team the owner is on may grant', async () => {
  const pg = fakePg({ callerRole: 'head_of_contents', unitOwner: OTHER, managesOwnerTeam: true });
  const body = await push(pg, [{ operation: 'INSERT', table_name: 'unit_access', payload: { ...GRANT_ROW } }]);
  assert.deepEqual(body.ok, ['e1']);
});

test('unit_access: an unrelated crew caller is a permanent rejection (grant and revoke)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', unitOwner: OTHER });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'unit_access', payload: { ...GRANT_ROW } },
    { operation: 'DELETE', table_name: 'unit_access', payload: { location_id: 'loc-1', user_id: OTHER } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 2);
  for (const c of body.conflicts) assert.match(c.error, PERMANENT);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO unit_access') || q.sql.includes('DELETE FROM unit_access')));
});

test('unit_access: a write against a missing location fails closed (permanent)', async () => {
  const pg = fakePg({ callerRole: 'full_admin', unitLocMissing: true });
  const body = await push(pg, [{ operation: 'INSERT', table_name: 'unit_access', payload: { ...GRANT_ROW, location_id: 'loc-ghost' } }]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
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

// ── #176: vehicles lock/share guard (value-change keyed) ────────────────────

const VEH_ROW = { location_id: 'veh-1', truck_mount: 0, updated_at: NOW };

test('vehicles: a crew fuel/tank write carrying UNCHANGED lock cols passes untouched (the non-negotiable case)', async () => {
  const pg = fakePg({
    callerRole: 'construction_crew', // tier-1, not the owner, no team share — no manage authority at all
    vehicleFacts: {
      ownerUserId: OTHER, checkoutLocked: true, openCheckout: false,
      lockedBy: 'pm-1', lockedByRole: 'production_manager', sharesOwnerTeam: false,
    },
  });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'vehicles', payload: {
      ...VEH_ROW, debris_level: 40, checkout_locked: true, open_checkout: false, locked_by: 'pm-1',
    } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO vehicles'));
  assert.ok(ins, 'the write must reach SQL');
  assert.ok(ins!.params.includes('pm-1'), 'the unchanged locked_by must survive as-is');
});

test('vehicles: a crew caller flipping checkout_locked ON is a permanent rejection', async () => {
  const pg = fakePg({
    callerRole: 'construction_crew',
    vehicleFacts: { ownerUserId: OTHER, checkoutLocked: false, openCheckout: false, sharesOwnerTeam: false },
  });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'vehicles', payload: { ...VEH_ROW, checkout_locked: true, open_checkout: false, locked_by: CALLER } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO vehicles')));
});

test('vehicles: locking ON is server-stamped to the CALLER, ignoring a forged locked_by', async () => {
  const pg = fakePg({
    callerRole: 'construction_crew',
    vehicleFacts: { ownerUserId: CALLER, checkoutLocked: false, openCheckout: false, sharesOwnerTeam: false },
  });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'vehicles', payload: { ...VEH_ROW, checkout_locked: true, open_checkout: false, locked_by: OTHER } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO vehicles'));
  assert.ok(ins!.params.includes(CALLER), 'locked_by must be the authenticated caller');
  assert.ok(!ins!.params.includes(OTHER), 'the forged locker must not survive');
});

test('vehicles: a lower-tier owner cannot lift a higher-tier PM lock (the #167 case)', async () => {
  const pg = fakePg({
    callerRole: 'construction_crew', // tier-1
    vehicleFacts: {
      ownerUserId: CALLER, checkoutLocked: true, openCheckout: false,
      lockedBy: 'pm-1', lockedByRole: 'production_manager', // tier-2
    },
  });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'vehicles', payload: { ...VEH_ROW, checkout_locked: false, open_checkout: false, locked_by: null } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO vehicles')));
});

test('vehicles: the owner may lift their OWN lock', async () => {
  const pg = fakePg({
    callerRole: 'construction_crew',
    vehicleFacts: { ownerUserId: CALLER, checkoutLocked: true, openCheckout: false, lockedBy: CALLER },
  });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'vehicles', payload: { ...VEH_ROW, checkout_locked: false, open_checkout: false, locked_by: null } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO vehicles'));
  assert.ok(ins, 'the unlock must reach SQL');
});

test('vehicles: locked_by drift WITHOUT a lock transition is stripped back to the DB value (not rejected)', async () => {
  const pg = fakePg({
    callerRole: 'construction_crew', // no manage authority — proves this path needs none
    vehicleFacts: { ownerUserId: OTHER, checkoutLocked: true, openCheckout: false, lockedBy: 'pm-1', lockedByRole: 'production_manager', sharesOwnerTeam: false },
  });
  const body = await push(pg, [
    // checkout_locked unchanged (still true); locked_by claims a different user.
    { operation: 'INSERT', table_name: 'vehicles', payload: { ...VEH_ROW, checkout_locked: true, open_checkout: false, locked_by: CALLER } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  const ins = pg.queries.find(q => q.sql.includes('INSERT INTO vehicles'));
  assert.ok(ins!.params.includes('pm-1'), 'drifted locked_by must be stripped back to the DB value');
  assert.ok(!ins!.params.includes(CALLER), 'the claimed locked_by must not survive');
});

test('vehicles: a write against a missing location fails closed (permanent)', async () => {
  const pg = fakePg({ callerRole: 'full_admin', vehicleLocMissing: true });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'vehicles', payload: { ...VEH_ROW, location_id: 'veh-ghost' } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
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

// ── crew shelf exemption: stock-movers may INSERT the auto-created Shelf ─────
// (mirrors the #84 crew-vehicle exemption; no org flag — the recount/add flow
// that auto-creates the shelf is core, not opt-in)

test('locations INSERT of a Shelf by a checkin-holding crew role is allowed without manage_locations', async () => {
  // construction_crew: checkin+checkout, NO manage_locations, vehicle flag off.
  const pg = fakePg({ callerRole: 'construction_crew' });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'shelf-new', name: 'Shelf A', type: 'Shelf', active: true, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  assert.deepEqual(body.conflicts, []);
  assert.ok(pg.queries.some(q => q.sql.includes('INSERT INTO locations')), 'the shelf must reach SQL');
});

test('locations INSERT of a Shelf by a checkout-only role (temporary_employee) is allowed', async () => {
  // temporary_employee: checkout_inventory=true, checkin_inventory=false — the
  // exemption is checkin OR checkout, matching who can strand a stock write.
  const pg = fakePg({ callerRole: 'temporary_employee' });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'shelf-new', name: 'Shelf B', type: 'Shelf', active: true, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(pg.queries.some(q => q.sql.includes('INSERT INTO locations')));
});

test('locations INSERT of a Shelf by a role with neither checkin nor checkout stays a permanent rejection', async () => {
  // hr_manager: no manage_locations, no checkin/checkout — the exemption must
  // not open shelves to non-stock-movers.
  const pg = fakePg({ callerRole: 'hr_manager' });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'shelf-new', name: 'Shelf C', type: 'Shelf', active: true, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.match(body.conflicts[0].error, /manage_locations/);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO locations')));
});

test('the Shelf exemption does not open other location types (crew Room INSERT still rejected)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'loc-new', name: 'Sneaky Room', type: 'Room', active: true, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.match(body.conflicts[0].error, /manage_locations/);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO locations')));
});

test('locations UPDATE/DELETE stay behind manage_locations even for a Shelf (exemption is INSERT-only)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'locations', payload: { id: 'shelf-1', name: 'Renamed', type: 'Shelf' } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
});

// ── FK-violation dead-letter: a genuine orphan must read as PERMANENT ────────
// The client dropped a rejected parent INSERT, so its dependent row can never
// apply — retrying forever wedges the outbox. 23503 gets the 'cannot' wording
// the mobile classifier dead-letters on; everything else stays transient.

test('an FK-violating write (23503) returns a permanent \'cannot apply\' conflict without leaking DB internals', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', failOn: 'INSERT INTO stock_by_location', failCode: '23503' });
  const body = await push(pg, [
    { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'item-1', location_id: 'loc-ghost', delta: 3, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 1);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.match(body.conflicts[0].error, /cannot apply/);
  // A3: the raw Postgres message (table/constraint names) must never echo back.
  assert.ok(!/foreign key|fkey|constraint|violates/i.test(body.conflicts[0].error), 'DB internals must not leak');
});

test('a non-FK write failure stays the generic transient \'write rejected\'', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', failOn: 'INSERT INTO stock_by_location' });
  const body = await push(pg, [
    { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'item-1', location_id: 'loc-1', delta: 3, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts[0].error, 'write rejected');
  assert.doesNotMatch(body.conflicts[0].error, PERMANENT, 'a possibly-transient failure must keep retrying');
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

// ── #122 Phase C: on_call_coverage INSERT fan-out through /sync/push ─────────
// Pins the applyEntry hook wiring itself (right table check, claimEvent key,
// deliver reached with the resolved PM recipients) — the resolver units in
// lib/notifications.test.ts can't catch a swallowed error or a dead hook here.

test('on_call_coverage INSERT: fan-out claims the coverage dedup key and delivers to the PM roster', async () => {
  const pg = fakePg({ callerRole: 'production_manager', pmRoster: ['pm1', 'pm2'] });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'on_call_coverage', payload: {
      id: 'cov-1', date_start: '2026-07-20', date_end: '2026-07-22',
      user_off: 'u-off', covering_user: 'u-cover', created_at: NOW, updated_at: NOW,
    } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(pg.queries.some(q => q.sql.includes('INSERT INTO on_call_coverage')), 'the coverage row must reach SQL');
  // The fan-out is fire-and-forget: every fake-pg await settles in microtasks,
  // so a setImmediate hop (twice, for safety) lets the whole chain finish.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const claim = pg.queries.find(q => q.sql.includes('INSERT INTO notification_dedup'));
  assert.ok(claim, 'the fan-out must claim the dedup ledger');
  assert.deepEqual(claim!.params, ['oncall:coverage:cov-1']);
  const inbox = pg.queries.filter(q => q.sql.includes('INSERT INTO notifications'));
  assert.deepEqual(inbox.map(q => q.params[1]).sort(), ['pm1', 'pm2'], 'every resolved PM gets an inbox row');
  for (const q of inbox) assert.equal(q.params[2], 'on_call');
});

test('on_call_coverage writes require manage_teams (crew cannot author coverage)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', pmRoster: ['pm1'] });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'on_call_coverage', payload: { id: 'cov-2', date_start: '2026-07-20', date_end: '2026-07-22' } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.match(body.conflicts[0].error, /manage_teams/);
  await new Promise(r => setImmediate(r));
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO notification_dedup')), 'a rejected write must never notify');
});

// ── #129 / #122 A1: vehicle name-merge + no sub-areas under units ────────────

test('#129: a duplicate Vehicle INSERT is merged — ok\'d, reported in merged[], never inserted', async () => {
  const pg = fakePg({ vehicleDupSurvivor: 'veh-survivor' });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody([
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'veh-dup', name: ' van 7 ', type: 'Vehicle', active: true, updated_at: NOW } },
    { operation: 'INSERT', table_name: 'vehicles', payload: { location_id: 'veh-dup', truck_mount: false, updated_at: NOW } },
  ]) });
  const body = res.json() as { ok: string[]; conflicts: unknown[]; merged: Array<{ id: string; duplicate_id: string; survivor_id: string }> };
  assert.deepEqual(body.ok, ['e1', 'e2']);
  assert.deepEqual(body.merged, [{ id: 'e1', duplicate_id: 'veh-dup', survivor_id: 'veh-survivor' }]);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO locations')), 'dup row never inserted');
  // In-batch remap: the follow-up vehicles row landed on the survivor.
  const veh = pg.queries.find(q => q.sql.includes('INSERT INTO vehicles'));
  assert.ok(veh && veh.params.includes('veh-survivor') && !veh.params.includes('veh-dup'));
  await app.close();
});

test('#129: a Vehicle INSERT with a fresh name applies normally and merged[] is empty', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody([
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'veh-new', name: 'Van 9', type: 'Vehicle', active: true, updated_at: NOW } },
  ]) });
  const body = res.json() as { ok: string[]; merged: unknown[] };
  assert.deepEqual(body.ok, ['e1']);
  assert.deepEqual(body.merged, []);
  assert.ok(pg.queries.some(q => q.sql.includes('INSERT INTO locations')));
  await app.close();
});

test('no sub-areas: parenting a location under a Vehicle/Locker is a permanent rejection', async () => {
  const pg = fakePg({ parentType: 'Vehicle' });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody([
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'room-x', name: 'Back Shelf', parent_id: 'veh-1', type: 'Room', active: true, updated_at: NOW } },
    { operation: 'UPDATE', table_name: 'locations', payload: { id: 'room-y', parent_id: 'veh-1' } },
  ]) });
  const body = res.json() as { ok: string[]; conflicts: Array<{ error: string }> };
  assert.deepEqual(body.ok, []);
  assert.equal(body.conflicts.length, 2);
  for (const c of body.conflicts) { assert.match(c.error, PERMANENT); assert.match(c.error, /sub-area/); }
  await app.close();
});

test('no sub-areas: a normal parent (Building) still accepts children', async () => {
  const pg = fakePg({ parentType: 'Building' });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'POST', url: '/sync/push', payload: pushBody([
    { operation: 'INSERT', table_name: 'locations', payload: { id: 'room-z', name: 'Product Room', parent_id: 'bldg-1', type: 'Room', active: true, updated_at: NOW } },
  ]) });
  assert.deepEqual((res.json() as { ok: string[] }).ok, ['e1']);
  await app.close();
});

// ── role dashboard presets: assignment is a role_settings write → existing guards apply ──

test('role_settings: dashboard_preset_id on a role above the caller is a permanent rejection', async () => {
  const pg = fakePg({ callerRole: 'franchise_manager' });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'role_settings', payload: { role: 'full_admin', dashboard_preset_id: 'preset-1', updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO role_settings')), 'the write must never reach SQL');
});

test('role_settings: a manage_roles_permissions holder may assign a preset to a role below them', async () => {
  const pg = fakePg({ callerRole: 'franchise_manager' });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'role_settings', payload: { role: 'hr_manager', dashboard_preset_id: 'preset-1', updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  assert.ok(pg.queries.some(q => /role_settings/.test(q.sql) && q.params.includes('preset-1')), 'dashboard_preset_id must survive the column policy');
});

// ── #162: team-scoped unit inventory (stock + equipment moves) ───────────────

const FOREIGN_VEHICLE = { type: 'Vehicle', is_owner: false, has_grant: false, shares_team: false, owner_user_id: OTHER };

test('#162 ADJUST: stock INTO a foreign-team vehicle is a permanent rejection for a crew caller', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', adjustLoc: FOREIGN_VEHICLE });
  const body = await push(pg, [
    { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'i1', location_id: 'veh-1', delta: 5, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.match(body.conflicts[0].error, /another team/i);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO stock_by_location')), 'the stock write must never reach SQL');
});

test('#162 ADJUST: stock OUT OF a foreign-team vehicle is rejected too (both directions)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', adjustLoc: FOREIGN_VEHICLE });
  const body = await push(pg, [
    { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'i1', location_id: 'veh-1', delta: -3, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
});

test('#162 ADJUST: a caller sharing a team with the owner passes', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', adjustLoc: { ...FOREIGN_VEHICLE, shares_team: true } });
  const body = await push(pg, [
    { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'i1', location_id: 'veh-1', delta: 5, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
});

test('#162 ADJUST: an ownerless unit and a main location are unrestricted', async () => {
  for (const loc of [{ ...FOREIGN_VEHICLE, owner_user_id: null }, { ...FOREIGN_VEHICLE, type: 'Warehouse' }]) {
    const pg = fakePg({ callerRole: 'construction_crew', adjustLoc: loc });
    const body = await push(pg, [
      { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'i1', location_id: 'loc-1', delta: 5, updated_at: NOW } },
    ]);
    assert.deepEqual(body.ok, ['e1'], `type=${loc.type} owner=${loc.owner_user_id}`);
  }
});

test('#162 ADJUST: an unknown location passes the team guard (no row → unrestricted)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew' }); // no adjustLoc → location missing
  const body = await push(pg, [
    { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'i1', location_id: 'ghost', delta: 5, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
});

test('#162: a full_admin (role default) and a crew with a user override both pass', async () => {
  for (const opts of [
    { callerRole: 'full_admin', adjustLoc: FOREIGN_VEHICLE },
    { callerRole: 'construction_crew', adjustLoc: FOREIGN_VEHICLE, callerOverrides: { manage_other_team_inventory: true } },
  ]) {
    const pg = fakePg(opts);
    const body = await push(pg, [
      { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'i1', location_id: 'veh-1', delta: 5, updated_at: NOW } },
    ]);
    assert.deepEqual(body.ok, ['e1'], `role=${opts.callerRole}`);
  }
});

test('#162 INSERT: a recount into a foreign-team locker is a permanent rejection', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', adjustLoc: { ...FOREIGN_VEHICLE, type: 'Locker' } });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'stock_by_location', payload: { item_id: 'i1', location_id: 'lkr-1', quantity: 10, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.ok(!pg.queries.some(q => q.sql.includes('INSERT INTO stock_by_location')), 'the recount must never reach SQL');
});

test('#162 equipment: moving a unit INTO a foreign-team vehicle is a permanent rejection (tier-2 manager)', async () => {
  const pg = fakePg({
    callerRole: 'production_manager',
    unitLocById: { 'veh-1': { type: 'Vehicle', owner_user_id: OTHER, is_owner: false, shares_team: false } },
    equipOldLocation: null,
  });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'equipment_units', payload: { id: 'eq-1', current_location_id: 'veh-1', updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.ok(!pg.queries.some(q => q.sql.startsWith('UPDATE equipment_units')), 'the move must never reach SQL');
});

test('#162 equipment: moving a unit OUT OF a foreign-team vehicle (to a main location) is rejected', async () => {
  const pg = fakePg({
    callerRole: 'production_manager',
    unitLocById: {
      'wh-1': { type: 'Warehouse', owner_user_id: null },
      'veh-old': { type: 'Vehicle', owner_user_id: OTHER, is_owner: false, shares_team: false },
    },
    equipOldLocation: 'veh-old',
  });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'equipment_units', payload: { id: 'eq-1', current_location_id: 'wh-1', updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
});

test('#162 equipment: a same-team move and an ownerless-unit move both pass', async () => {
  const pg = fakePg({
    callerRole: 'production_manager',
    unitLocById: {
      'veh-mine': { type: 'Vehicle', owner_user_id: OTHER, is_owner: false, shares_team: true },
      'veh-free': { type: 'Vehicle', owner_user_id: null },
    },
    equipOldLocation: 'veh-free',
  });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'equipment_units', payload: { id: 'eq-1', current_location_id: 'veh-mine', updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
});

test('#126 locker guard still fires FIRST for a negative delta from a locker the caller has no access to', async () => {
  const pg = fakePg({
    callerRole: 'construction_crew',
    adjustLoc: { type: 'Locker', is_owner: false, has_grant: false, shares_team: false, owner_user_id: OTHER },
  });
  const body = await push(pg, [
    { operation: 'ADJUST', table_name: 'stock_by_location', payload: { item_id: 'i1', location_id: 'lkr-1', delta: -2, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, /locker/i);
});

test('#162 equipment: an INSERT (upsert) that pulls a unit out of a foreign-team vehicle is rejected too', async () => {
  const pg = fakePg({
    callerRole: 'full_admin', // has add_inventory; override below removes the cross-team perm
    callerOverrides: { manage_other_team_inventory: false },
    unitLocById: {
      'veh-old': { type: 'Vehicle', owner_user_id: OTHER, is_owner: false, shares_team: false },
    },
    equipOldLocation: 'veh-old',
  });
  const body = await push(pg, [
    // Re-INSERT of an existing row moving it to a job (current_location_id null).
    { operation: 'INSERT', table_name: 'equipment_units', payload: { id: 'eq-1', item_id: 'i1', asset_tag: 'AM-1', status: 'deployed', current_location_id: null, current_job_id: 'job-1', created_at: NOW, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
});

// ── #178 v1: repair_steps is an immutable troubleshooting log ────────────────

test('repair_steps: INSERT with edit_inventory applies and stamps created_by to the caller', async () => {
  const pg = fakePg({ callerRole: 'full_admin' });
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'repair_steps', payload: { id: 'step-1', repair_id: 'r-1', action: 'Checked the fuse', result: 'Blown — replaced it', created_by: 'forged-user', created_at: NOW, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, ['e1']);
  assert.deepEqual(body.conflicts, []);
  assert.ok(pg.queries.some(q => q.sql.includes('INSERT INTO repair_steps') && q.params.includes(CALLER)),
    'created_by must be stamped to the caller, not the forged payload value');
});

test('repair_steps: INSERT is rejected without edit_inventory', async () => {
  const pg = fakePg({ callerRole: 'temporary_employee' }); // tier 1, no edit_inventory
  const body = await push(pg, [
    { operation: 'INSERT', table_name: 'repair_steps', payload: { id: 'step-2', repair_id: 'r-1', action: 'Checked the fuse', created_at: NOW, updated_at: NOW } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, /edit_inventory/);
});

test('repair_steps: a crafted UPDATE on an existing step is rejected as a permanent DENY, even for a full editor', async () => {
  const pg = fakePg({ callerRole: 'full_admin' });
  const body = await push(pg, [
    { operation: 'UPDATE', table_name: 'repair_steps', payload: { id: 'step-1', action: 'rewritten after the fact', result: 'covering up a mistake' } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.match(body.conflicts[0].error, /repair_steps\/UPDATE/);
  assert.ok(!pg.queries.some(q => q.sql.startsWith('UPDATE repair_steps')), 'the step row must never be touched by SQL');
});

test('repair_steps: a crafted DELETE on an existing step is rejected as a permanent DENY', async () => {
  const pg = fakePg({ callerRole: 'full_admin' });
  const body = await push(pg, [
    { operation: 'DELETE', table_name: 'repair_steps', payload: { id: 'step-1' } },
  ]);
  assert.deepEqual(body.ok, []);
  assert.match(body.conflicts[0].error, PERMANENT);
  assert.ok(!pg.queries.some(q => q.sql.startsWith('DELETE FROM repair_steps')), 'the step row must never be deleted via sync');
});

// ── #235: stable machine-readable rejection codes on push conflicts ──────────
// The mobile engine's rejectionClassify.ts prefers `code` over the legacy
// wording regex — one assertion per SyncRejectionCode value so a future edit
// that flips a site's classification is caught by CI, not just by comments.

test('push: conflicts[].code — NOT_ALLOWED for a table outside the sync allowlist', async () => {
  const pg = fakePg();
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{ operation: 'INSERT', table_name: 'api_request_audit', payload: { id: 'x' } }]),
  });
  const body = res.json() as { conflicts: Array<{ error: string; code: string }> };
  assert.equal(body.conflicts.length, 1);
  assert.equal(body.conflicts[0].code, 'NOT_ALLOWED');
  await app.close();
});

test('push: conflicts[].code — FORBIDDEN for a non-sender messages UPDATE', async () => {
  const pg = fakePg({ messageSender: OTHER });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{ operation: 'UPDATE', table_name: 'messages', payload: { id: 'msg-1', body: 'rewritten', edited_at: NOW } }]),
  });
  const body = res.json() as { conflicts: Array<{ error: string; code: string }> };
  assert.equal(body.conflicts.length, 1);
  assert.equal(body.conflicts[0].code, 'FORBIDDEN');
  await app.close();
});

test('push: conflicts[].code — MAINTENANCE while the write freeze is on', async () => {
  // A system_settings holder (the fake's default full_admin) is maintenance-
  // exempt — the freeze only bites non-exempt callers.
  const pg = fakePg({ maintenanceOn: true, callerRole: 'mitigation_technician' });
  const app = await buildApp(pg);
  const res = await app.inject({
    method: 'POST', url: '/sync/push',
    payload: pushBody([{ operation: 'INSERT', table_name: 'app_config', payload: { key: 'approval_threshold_qty', value: '50', updated_at: NOW } }]),
  });
  const body = res.json() as { conflicts: Array<{ error: string; code: string }> };
  assert.equal(body.conflicts.length, 1);
  assert.equal(body.conflicts[0].code, 'MAINTENANCE');
  await app.close();
});

test('push: conflicts[].code — VALIDATION for an FK violation, CONFLICT for any other write error', async () => {
  // Same failing write, two Postgres error codes: 23503 (fk) must classify as a
  // permanent payload/reference problem; anything else stays transient.
  for (const [failCode, expected] of [['23503', 'VALIDATION'], [undefined, 'CONFLICT']] as const) {
    const pg = fakePg({ failOn: 'INSERT INTO app_config', failCode });
    const app = await buildApp(pg);
    const res = await app.inject({
      method: 'POST', url: '/sync/push',
      payload: pushBody([{ operation: 'INSERT', table_name: 'app_config', payload: { key: 'approval_threshold_qty', value: '50', updated_at: NOW } }]),
    });
    const body = res.json() as { conflicts: Array<{ error: string; code: string }> };
    assert.equal(body.conflicts.length, 1, `failCode=${failCode}`);
    assert.equal(body.conflicts[0].code, expected, `failCode=${failCode}`);
    await app.close();
  }
});

// ── #204: server-side sync scoping for view_teams/view_locations ────────────
// Column redaction (locations, gated on view_locations) + a team_members
// row-level self-carve-out (gated on view_teams) — computed identically in
// /sync/full and /sync/pull. teams itself carries no sensitive columns and is
// never gated by either permission.

test('full: locations hides latitude/longitude/subareas_require_owner without view_locations; owner_user_id (BASE) survives', async () => {
  const pg = fakePg({ callerOverrides: { view_locations: false } });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'GET', url: '/sync/full?table=locations' });
  assert.equal(res.statusCode, 200);
  const { rows } = res.json() as { rows: Array<Record<string, unknown>> };
  assert.equal(rows.length, 1);
  assert.ok('owner_user_id' in rows[0], 'owner_user_id (BASE, mobile-grep verified) must survive');
  assert.ok('name' in rows[0] && 'active' in rows[0] && 'type' in rows[0] && 'has_shelves' in rows[0]);
  assert.ok(!('latitude' in rows[0]) && !('longitude' in rows[0]) && !('subareas_require_owner' in rows[0]));
  await app.close();
});

test('full: locations exposes latitude/longitude/subareas_require_owner WITH view_locations', async () => {
  const pg = fakePg({ callerOverrides: { view_locations: true } });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'GET', url: '/sync/full?table=locations' });
  const { rows } = res.json() as { rows: Array<Record<string, unknown>> };
  assert.equal(rows[0].latitude, 39.5);
  assert.equal(rows[0].longitude, -98.35);
  assert.equal(rows[0].subareas_require_owner, false);
  await app.close();
});

test('pull: locations redaction matches /full exactly (parity requirement)', async () => {
  const pg = fakePg({ callerOverrides: { view_locations: false } });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'GET', url: '/sync/pull?since=2020-01-01T00:00:00.000Z' });
  const rows = (res.json() as Record<string, { rows: Array<Record<string, unknown>> }>).locations.rows;
  assert.equal(rows.length, 1);
  assert.ok('owner_user_id' in rows[0]);
  assert.ok(!('latitude' in rows[0]) && !('longitude' in rows[0]) && !('subareas_require_owner' in rows[0]));
  await app.close();
});

test('full: a caller WITHOUT view_teams is restricted to their own team_members row — overrides canSeeAllTeams', async () => {
  // full_admin is org-authority (canSeeAllTeams=true) — without this fix an
  // explicit per-user revoke of view_teams would be silently ignored and
  // they'd still see every team's roster.
  const pg = fakePg({ callerRole: 'full_admin', callerOverrides: { view_teams: false } });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'GET', url: '/sync/full?table=team_members' });
  const { rows } = res.json() as { rows: Array<{ user_id: string }> };
  assert.deepEqual(rows.map(r => r.user_id), [CALLER]);
  await app.close();
});

test('full: an org-authority caller WITH view_teams still sees every team\'s members (canSeeAllTeams, unscoped, unaffected by this fix)', async () => {
  const pg = fakePg({ callerRole: 'full_admin', callerOverrides: { view_teams: true } });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'GET', url: '/sync/full?table=team_members' });
  const { rows } = res.json() as { rows: Array<{ user_id: string }> };
  assert.deepEqual(rows.map(r => r.user_id).sort(), ['not-my-teammate', 'teammate-1', CALLER].sort());
  await app.close();
});

test('full: a tier-1 caller WITHOUT view_teams sees only their own row — not even a teammate\'s', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', callerOverrides: { view_teams: false } });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'GET', url: '/sync/full?table=team_members' });
  const { rows } = res.json() as { rows: Array<{ user_id: string }> };
  assert.deepEqual(rows.map(r => r.user_id), [CALLER]);
  await app.close();
});

test('full: a tier-1 caller WITH view_teams sees their own team\'s roster, not the whole org (baseline teamScopeSql, unaffected by this fix)', async () => {
  const pg = fakePg({ callerRole: 'construction_crew', callerOverrides: { view_teams: true } });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'GET', url: '/sync/full?table=team_members' });
  const { rows } = res.json() as { rows: Array<{ user_id: string }> };
  assert.deepEqual(rows.map(r => r.user_id).sort(), ['teammate-1', CALLER].sort());
  await app.close();
});

test('pull: the self-row carve-out matches /full exactly (parity requirement)', async () => {
  const pg = fakePg({ callerRole: 'full_admin', callerOverrides: { view_teams: false } });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'GET', url: '/sync/pull?since=2020-01-01T00:00:00.000Z' });
  const rows = (res.json() as Record<string, { rows: Array<{ user_id: string }> }>).team_members.rows;
  assert.deepEqual(rows.map(r => r.user_id), [CALLER]);
  await app.close();
});

test('full: teams itself is never gated by view_teams (request still succeeds; no sensitive columns to redact)', async () => {
  const pg = fakePg({ callerRole: 'full_admin', callerOverrides: { view_teams: false } });
  const app = await buildApp(pg);
  const res = await app.inject({ method: 'GET', url: '/sync/full?table=teams' });
  assert.equal(res.statusCode, 200);
  await app.close();
});
