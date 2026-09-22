import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// teams.ts can't load under `node --test` as-is: db/schema imports the native
// op-sqlite binding, and auth/session (getValidJwt, for the manager-toggle /
// permission-override / reconcileTeams online paths) imports
// expo-secure-store. Same harness as users.test.ts: swap db/schema for a REAL
// sql.js database (./testDb) and auth/session for a controllable stub.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./testDb') as typeof import('./testDb');

let fakeJwt: string | null = null;

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  if (request === 'react-native' || request === 'expo' || request === 'expo-modules-core') {
    return new Proxy({ __esModule: true }, { get: (_t, p) => (p === '__esModule' ? true : () => {}) });
  }
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  if (resolved.endsWith('/src/auth/session.ts')) return { getValidJwt: async () => fakeJwt };
  return origLoad.call(this, request, parent, isMain);
};

let teams: typeof import('./teams');

const NOW = '2026-09-01T00:00:00.000Z';

function seedTeam(id: string, name: string, type = 'Construction') {
  testDb.getDb().executeSync(
    `INSERT INTO teams (id, name, type, updated_at, synced_at) VALUES (?, ?, ?, ?, NULL)`,
    [id, name, type, NOW],
  );
}
function seedMember(teamId: string, userId: string, subteamId: string | null = null, role: string | null = null) {
  testDb.getDb().executeSync(
    `INSERT INTO team_members (team_id, user_id, team_permission_overrides, added_by, joined_at, is_manager, updated_at, subteam_id, subteam_role)
     VALUES (?, ?, '{}', NULL, ?, 0, ?, ?, ?)`,
    [teamId, userId, NOW, NOW, subteamId, role],
  );
}
function seedUser(id: string, name: string) {
  testDb.getDb().executeSync(
    `INSERT INTO users (id, name, role, pin_length_required, permission_overrides, active, created_at, updated_at)
     VALUES (?, ?, 'construction_crew', 4, '{}', 1, ?, ?)`,
    [id, name, NOW, NOW],
  );
}

before(async () => {
  await testDb.initTestDb(['teams', 'team_members', 'subteams', 'users', 'taxonomy_types', 'app_settings', 'outbox']);
  teams = requireCjs('./teams') as typeof import('./teams');
  seedUser('u-1', 'Alice');
  seedUser('u-2', 'Bob');
  seedUser('u-3', 'Carl');
});

// ── teams CRUD ─────────────────────────────────────────────────────────

test('createTeam inserts locally + queues an outbox INSERT, dual-writing type_id', () => {
  const { id } = teams.createTeam('Roofing', 'Construction');
  const row = testDb.getDb().executeSync(`SELECT name, type FROM teams WHERE id = ?`, [id]).rows[0] as { name: string; type: string };
  assert.equal(row.name, 'Roofing');
  const ob = testDb.getDb().executeSync(`SELECT payload FROM outbox WHERE table_name='teams' AND operation='INSERT'`).rows[0] as { payload: string };
  const payload = JSON.parse(ob.payload) as Record<string, unknown>;
  assert.equal(payload.name, 'Roofing');
  assert.equal(payload.type_id, undefined, 'type_id is local-only, never pushed (mirrors upsertLocation)');
});

test('updateTeam preserves the existing synced_at watermark', () => {
  testDb.getDb().executeSync(`UPDATE teams SET synced_at = ? WHERE id = (SELECT id FROM teams LIMIT 1)`, ['2026-08-01T00:00:00.000Z']);
  const team = teams.getAllTeams()[0];
  teams.updateTeam(team, `${team.name} Renamed`, team.type);
  const row = testDb.getDb().executeSync(`SELECT name, synced_at FROM teams WHERE id = ?`, [team.id]).rows[0] as { name: string; synced_at: string };
  assert.equal(row.name, `${team.name} Renamed`);
  assert.equal(row.synced_at, '2026-08-01T00:00:00.000Z');
});

// ── team_members roster ────────────────────────────────────────────────

test('addTeamMember inserts once; a duplicate add is a silent no-op (no dup row, no outbox churn)', () => {
  seedTeam('team-roster', 'Roster Team');
  const first = teams.addTeamMember('team-roster', 'u-1');
  assert.ok(first?.joined_at);
  const second = teams.addTeamMember('team-roster', 'u-1');
  assert.equal(second, null);
  const count = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM team_members WHERE team_id='team-roster' AND user_id='u-1'`).rows[0] as { n: number };
  assert.equal(count.n, 1);
  const obCount = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox WHERE table_name='team_members' AND operation='INSERT'`).rows[0] as { n: number };
  assert.equal(obCount.n, 1, 'only the first add queued an outbox row');
});

test('removeTeamMember deletes the row and queues an outbox DELETE', () => {
  seedTeam('team-remove', 'Remove Team');
  teams.addTeamMember('team-remove', 'u-2');
  teams.removeTeamMember('team-remove', 'u-2');
  const count = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM team_members WHERE team_id='team-remove' AND user_id='u-2'`).rows[0] as { n: number };
  assert.equal(count.n, 0);
  const ob = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox WHERE table_name='team_members' AND operation='DELETE'`).rows[0] as { n: number };
  assert.equal(ob.n, 1);
});

test('getTeamMembers left-joins user name/role', () => {
  seedTeam('team-view', 'View Team');
  teams.addTeamMember('team-view', 'u-3');
  const members = teams.getTeamMembers('team-view');
  assert.equal(members.length, 1);
  assert.equal(members[0].user_name, 'Carl');
});

test('setMemberManagerOnline / setMemberPermissionOverridesOnline reject without a session', async () => {
  fakeJwt = null;
  await assert.rejects(() => teams.setMemberManagerOnline('team-view', 'u-3', true));
  await assert.rejects(() => teams.setMemberPermissionOverridesOnline('team-view', 'u-3', { checkout_inventory: true }));
});

// ── subteams (crews) ───────────────────────────────────────────────────

test('createSubteam + setSubteamMembership build a crew with a lead and a helper', () => {
  seedTeam('team-crew', 'Crew Team');
  teams.addTeamMember('team-crew', 'u-1');
  teams.addTeamMember('team-crew', 'u-2');
  const subteamId = teams.createSubteam('team-crew', 'TV/FT');
  teams.setSubteamMembership(subteamId, 'u-1', 'lead');
  teams.setSubteamMembership(subteamId, 'u-2', 'helper');
  const crews = teams.getSubteamsForTeam('team-crew');
  assert.equal(crews.length, 1);
  assert.equal(crews[0].lead?.id, 'u-1');
  assert.deepEqual(crews[0].helpers.map(h => h.id), ['u-2']);
});

test('setSubteamMembership throws for a non-member (rolls back, no outbox row)', () => {
  seedTeam('team-crew2', 'Crew Team 2');
  const subteamId = teams.createSubteam('team-crew2', 'Solo');
  const before_ = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number };
  assert.throws(() => teams.setSubteamMembership(subteamId, 'u-9-not-a-member', 'lead'));
  const after = testDb.getDb().executeSync(`SELECT COUNT(*) AS n FROM outbox`).rows[0] as { n: number };
  assert.equal(after.n, before_.n, 'the failed membership write must not leak an outbox row');
});

test('clearSubteamMembership no-ops (returns null, no outbox) when the member has no assignment', () => {
  seedTeam('team-clear', 'Clear Team');
  teams.addTeamMember('team-clear', 'u-1');
  const result = teams.clearSubteamMembership('team-clear', 'u-1');
  assert.equal(result, null);
});

test('clearSubteamMembership clears an existing assignment', () => {
  seedTeam('team-clear2', 'Clear Team 2');
  teams.addTeamMember('team-clear2', 'u-1');
  const st = teams.createSubteam('team-clear2', 'Crew');
  teams.setSubteamMembership(st, 'u-1', 'lead');
  const result = teams.clearSubteamMembership('team-clear2', 'u-1');
  assert.deepEqual(result, { team_id: 'team-clear2' });
  const row = testDb.getDb().executeSync(`SELECT subteam_id FROM team_members WHERE team_id='team-clear2' AND user_id='u-1'`).rows[0] as { subteam_id: string | null };
  assert.equal(row.subteam_id, null);
});

test('deleteSubteam soft-deletes (active=0) and clears every member assignment atomically', () => {
  seedTeam('team-del', 'Delete Team');
  teams.addTeamMember('team-del', 'u-1');
  teams.addTeamMember('team-del', 'u-2');
  const st = teams.createSubteam('team-del', 'Doomed Crew');
  teams.setSubteamMembership(st, 'u-1', 'lead');
  teams.setSubteamMembership(st, 'u-2', 'helper');
  const result = teams.deleteSubteam(st);
  assert.deepEqual(new Set(result.memberUserIds), new Set(['u-1', 'u-2']));
  assert.equal(teams.getSubteamsForTeam('team-del').length, 0, 'soft-deleted crew no longer listed as active');
  const rows = testDb.getDb().executeSync(`SELECT subteam_id FROM team_members WHERE team_id='team-del'`).rows as { subteam_id: string | null }[];
  assert.ok(rows.every(r => r.subteam_id === null), 'every member assignment cleared');
});

test('getMyCrews returns a user’s active crews across teams', () => {
  // A fresh user (not u-1, which already picked up a crew assignment from an
  // earlier test in this shared-testDb file) so this assertion isn't polluted
  // by cross-test state.
  seedUser('u-my', 'Dana');
  seedTeam('team-my1', 'My Team 1');
  seedTeam('team-my2', 'My Team 2');
  teams.addTeamMember('team-my1', 'u-my');
  teams.addTeamMember('team-my2', 'u-my');
  const c1 = teams.createSubteam('team-my1', 'Crew One');
  const c2 = teams.createSubteam('team-my2', 'Crew Two');
  teams.setSubteamMembership(c1, 'u-my', 'lead');
  teams.setSubteamMembership(c2, 'u-my', 'helper');
  const mine = teams.getMyCrews('u-my').map(c => c.name).sort();
  assert.deepEqual(mine, ['Crew One', 'Crew Two']);
});

// ── reconcileTeams ─────────────────────────────────────────────────────

test('reconcileTeams returns -1 (no session) without deleting anything', async () => {
  fakeJwt = null;
  testDb.getDb().executeSync(`DELETE FROM app_settings`);
  const removed = await teams.reconcileTeams();
  assert.equal(removed, -1);
});

test('reconcileTeams is throttled: a recent run returns 0 and skips even a truthy session', async () => {
  testDb.getDb().executeSync(`DELETE FROM app_settings`);
  testDb.getDb().executeSync(
    `INSERT INTO app_settings (key, value) VALUES ('teams_reconciled_at', ?)`,
    [String(Date.now())],
  );
  fakeJwt = 'test-jwt'; // would attempt network if not throttled — must not be reached
  const removed = await teams.reconcileTeams();
  assert.equal(removed, 0);
});

test('reconcileTeams deletes local team/team_members rows the server no longer returns', async (t) => {
  testDb.getDb().executeSync(`DELETE FROM app_settings`);
  testDb.getDb().executeSync(`DELETE FROM teams`);
  testDb.getDb().executeSync(`DELETE FROM team_members`);
  seedTeam('keep-1', 'Keep Me');
  seedTeam('stale-1', 'Stale Team');
  seedMember('keep-1', 'u-1');
  seedMember('stale-1', 'u-2');

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ rows: [{ id: 'keep-1' }], hasMore: false }),
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = origFetch; });

  fakeJwt = 'test-jwt';
  const removed = await teams.reconcileTeams();
  assert.equal(removed, 2, '1 stale team + 1 stale team_members row');
  const teamIds = (testDb.getDb().executeSync(`SELECT id FROM teams`).rows as { id: string }[]).map(r => r.id);
  assert.deepEqual(teamIds, ['keep-1']);
  const memberTeamIds = (testDb.getDb().executeSync(`SELECT team_id FROM team_members`).rows as { team_id: string }[]).map(r => r.team_id);
  assert.deepEqual(memberTeamIds, ['keep-1']);
  const lastRun = testDb.getDb().executeSync(`SELECT value FROM app_settings WHERE key='teams_reconciled_at'`).rows[0] as { value: string } | undefined;
  assert.ok(lastRun?.value, 'watermark recorded on success');
});

test('reconcileTeams clears the one-time purge flag on a successful run', async () => {
  testDb.getDb().executeSync(`DELETE FROM app_settings`);
  testDb.getDb().executeSync(`INSERT INTO app_settings (key, value) VALUES ('teams_purge_pending', '1')`);
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ rows: [], hasMore: false }),
  })) as typeof fetch;
  try {
    fakeJwt = 'test-jwt';
    await teams.reconcileTeams();
  } finally {
    globalThis.fetch = origFetch;
  }
  const flag = testDb.getDb().executeSync(`SELECT value FROM app_settings WHERE key='teams_purge_pending'`).rows[0];
  assert.equal(flag, undefined, 'purge flag cleared after a successful reconcile');
});
