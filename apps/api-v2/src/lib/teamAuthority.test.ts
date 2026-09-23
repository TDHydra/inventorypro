import { test } from 'node:test';
import assert from 'node:assert';
import { resolveTeamAuthority, managerActionBlocked, isOrgAuthority, foreignTeamUnitBlocked, resolveUnitInventoryFacts } from './teamAuthority';

// Minimal pg stub: returns whatever row the test hands it.
function pgReturning(row: unknown) {
  return { query: async () => ({ rows: row === undefined ? [] : [row] }) };
}

const TEAM = 'team-1';

test('full_admin is apex: org authority even without manage_teams and even as a manager', async () => {
  const auth = await resolveTeamAuthority(
    pgReturning({ role: 'full_admin', permission_overrides: { manage_teams: false }, role_overrides: null, is_manager: true }),
    'u1', TEAM,
  );
  assert.equal(auth.orgAdmin, true);
  assert.equal(auth.managerOnly, false);
  // Apex may do every manager-restricted action on a team they also manage.
  assert.equal(managerActionBlocked(auth, 'set_manager'), false);
  assert.equal(managerActionBlocked(auth, 'delete_team'), false);
});

test('org admin who ALSO manages the team keeps org authority (order of checks)', async () => {
  // The trap: classifying anyone with is_manager as manager-only would lock a
  // franchise_manager out of renaming the very team they run.
  const auth = await resolveTeamAuthority(
    pgReturning({ role: 'franchise_manager', permission_overrides: null, role_overrides: null, is_manager: true }),
    'u2', TEAM,
  );
  assert.equal(auth.orgAdmin, true);
  assert.equal(auth.managerOnly, false);
  assert.equal(managerActionBlocked(auth, 'rename_team'), false);
});

test('a team manager without org authority is blocked from all four actions', async () => {
  const auth = await resolveTeamAuthority(
    pgReturning({ role: 'production_manager', permission_overrides: null, role_overrides: null, is_manager: true }),
    'u3', TEAM,
  );
  assert.equal(auth.orgAdmin, false);
  assert.equal(auth.managerOnly, true);
  for (const a of ['set_manager', 'remove_self', 'rename_team', 'delete_team'] as const) {
    assert.equal(managerActionBlocked(auth, a), true, `${a} must be blocked`);
  }
});

// The bug this test was written to catch: tier 2 HOLDS manage_teams. Gating org
// authority on that permission made every team manager an org admin, so the four
// restrictions fired for nobody and the feature was a silent no-op.
test('tier-2 crew leads hold manage_teams but are NOT org authority', async () => {
  for (const role of ['production_manager', 'head_of_construction', 'head_of_contents', 'carpet_cleaning_manager']) {
    assert.equal(isOrgAuthority(role), false, `${role} must not be org authority`);
  }
  // …while tier 3+ is.
  for (const role of ['office_manager', 'hr_manager', 'franchise_manager', 'full_admin']) {
    assert.equal(isOrgAuthority(role), true, `${role} must be org authority`);
  }
  // …and tier 1 certainly is not.
  for (const role of ['construction_crew', 'mitigation_technician', 'temporary_employee']) {
    assert.equal(isOrgAuthority(role), false, `${role} must not be org authority`);
  }
});

test('org authority is a tier test, so a permission override cannot re-open it', async () => {
  const auth = await resolveTeamAuthority(
    pgReturning({ role: 'construction_crew', permission_overrides: { manage_teams: true }, role_overrides: null, is_manager: false }),
    'u4', TEAM,
  );
  assert.equal(auth.orgAdmin, false);
});

test('unknown role fails closed (tier undefined => not org authority)', () => {
  assert.equal(isOrgAuthority('not_a_role'), false);
  assert.equal(isOrgAuthority(null), false);
  assert.equal(isOrgAuthority(undefined), false);
});

test('unknown caller fails closed (no authority at all)', async () => {
  const auth = await resolveTeamAuthority(pgReturning(undefined), 'ghost', TEAM);
  assert.deepEqual(auth, { orgAdmin: false, managerOnly: false });
});

test('a plain member of the team has neither org nor manager authority', async () => {
  const auth = await resolveTeamAuthority(
    pgReturning({ role: 'construction_crew', permission_overrides: null, role_overrides: null, is_manager: false }),
    'u5', TEAM,
  );
  assert.equal(auth.orgAdmin, false);
  assert.equal(auth.managerOnly, false);
});

// ── #162 foreignTeamUnitBlocked — allow/deny matrix ──────────────────────────

const unitFacts = (over: Partial<import('./teamAuthority').UnitInventoryFacts> = {}) => ({
  type: 'Vehicle', ownerUserId: 'owner-1', isOwner: false, sharesOwnerTeam: false, ...over,
});

test('#162: unknown location (null facts) is unrestricted', () => {
  assert.equal(foreignTeamUnitBlocked(null, false), false);
  assert.equal(foreignTeamUnitBlocked(undefined, false), false);
});

test('#162: a main (non-unit) location is unrestricted', () => {
  assert.equal(foreignTeamUnitBlocked(unitFacts({ type: 'Warehouse' }), false), false);
  assert.equal(foreignTeamUnitBlocked(unitFacts({ type: null }), false), false);
});

test('#162: an ownerless unit is unrestricted', () => {
  assert.equal(foreignTeamUnitBlocked(unitFacts({ ownerUserId: null }), false), false);
});

test('#162: the owner and same-team callers pass', () => {
  assert.equal(foreignTeamUnitBlocked(unitFacts({ isOwner: true }), false), false);
  assert.equal(foreignTeamUnitBlocked(unitFacts({ sharesOwnerTeam: true }), false), false);
});

test('#162: a foreign-team unit is BLOCKED without manage_other_team_inventory (Vehicle and Locker)', () => {
  assert.equal(foreignTeamUnitBlocked(unitFacts(), false), true);
  assert.equal(foreignTeamUnitBlocked(unitFacts({ type: 'Locker' }), false), true);
});

test('#162: manage_other_team_inventory unblocks a foreign-team unit', () => {
  assert.equal(foreignTeamUnitBlocked(unitFacts(), true), false);
});

test('#162: resolveUnitInventoryFacts maps the row and null-location/missing-row to null', async () => {
  const pgRow = (row: unknown) => ({ query: async () => ({ rows: row ? [row] : [] }) });
  assert.equal(await resolveUnitInventoryFacts(pgRow(null) as never, null, 'me'), null);
  assert.equal(await resolveUnitInventoryFacts(pgRow(null) as never, 'loc-x', 'me'), null);
  const facts = await resolveUnitInventoryFacts(
    pgRow({ type: 'Locker', owner_user_id: 'owner-1', is_owner: null, shares_team: true }) as never,
    'loc-1', 'me',
  );
  assert.deepEqual(facts, { type: 'Locker', ownerUserId: 'owner-1', isOwner: false, sharesOwnerTeam: true });
});
