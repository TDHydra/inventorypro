import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_TIER, effectiveTier, canActOnTarget, canAssignRole, userHasPermission, ROLE_DEFAULTS } from './permissions';
import { TEAM_OVERRIDABLE_PERMISSIONS } from './syncPolicy';

// One representative role per tier (1..4). ROLE_TIER is the source of truth.
// Tier 4 here uses franchise_manager (a NON-apex tier-4 role) so the generic
// pair sweeps compare by raw tier; full_admin's apex behaviour is tested apart.
const ROLE_AT_TIER: Record<1 | 2 | 3 | 4, string> = {
  1: 'construction_crew',
  2: 'production_manager',
  3: 'office_manager',
  4: 'franchise_manager',
};
const TIERS = [1, 2, 3, 4] as const;

test('ROLE_TIER mirrors mobile: 14 roles across tiers 1..4', () => {
  const roles = Object.keys(ROLE_TIER);
  assert.equal(roles.length, 14);
  for (const r of roles) assert.ok([1, 2, 3, 4].includes(ROLE_TIER[r]));
  // Spot-check the anchors from apps/mobile/src/constants/roles.ts.
  assert.equal(ROLE_TIER.temporary_employee, 1);
  assert.equal(ROLE_TIER.production_manager, 2);
  assert.equal(ROLE_TIER.hr_manager, 3);
  assert.equal(ROLE_TIER.franchise_manager, 4);
  assert.equal(ROLE_TIER.full_admin, 4);
  // #Eddie: duct_cleaning_technician — new tier-1 crew role.
  assert.equal(ROLE_TIER.duct_cleaning_technician, 1);
});

test('canActOnTarget: every (callerTier, targetTier) pair — allowed iff caller >= target', () => {
  for (const c of TIERS) {
    for (const t of TIERS) {
      const expected = c >= t;
      assert.equal(
        canActOnTarget(ROLE_AT_TIER[c], ROLE_AT_TIER[t]),
        expected,
        `caller tier ${c} acting on target tier ${t} should be ${expected}`,
      );
    }
  }
});

test('canAssignRole: every (callerTier, newTier) pair — allowed iff newTier <= caller', () => {
  for (const c of TIERS) {
    for (const n of TIERS) {
      const expected = n <= c;
      assert.equal(
        canAssignRole(ROLE_AT_TIER[c], ROLE_AT_TIER[n]),
        expected,
        `caller tier ${c} assigning role tier ${n} should be ${expected}`,
      );
    }
  }
});

test('canActOnTarget fails closed on unknown/missing roles', () => {
  // Unknown caller → tier 0 → can act on nobody (even lowest tier).
  assert.equal(canActOnTarget('not_a_role', 'construction_crew'), false);
  assert.equal(canActOnTarget(undefined, 'construction_crew'), false);
  assert.equal(canActOnTarget(null, 'full_admin'), false);
  // Unknown target → tier 4 → only a tier-4 caller could act, never below.
  assert.equal(canActOnTarget('full_admin', 'not_a_role'), true);
  assert.equal(canActOnTarget('office_manager', 'not_a_role'), false);
  assert.equal(canActOnTarget('full_admin', undefined), true);
  assert.equal(canActOnTarget('office_manager', null), false);
  // Both unknown → 0 >= 4 is false.
  assert.equal(canActOnTarget('x', 'y'), false);
});

test('canAssignRole fails closed on unknown/missing roles', () => {
  // Unknown newRole → always deny, regardless of caller.
  assert.equal(canAssignRole('full_admin', 'not_a_role'), false);
  assert.equal(canAssignRole('full_admin', undefined), false);
  assert.equal(canAssignRole('full_admin', null), false);
  // Unknown/missing caller → tier 0 → can assign nothing (even a known tier-1 role).
  assert.equal(canAssignRole('not_a_role', 'construction_crew'), false);
  assert.equal(canAssignRole(undefined, 'construction_crew'), false);
  assert.equal(canAssignRole(null, 'full_admin'), false);
});

test('effectiveTier: full_admin is apex (5); others map to raw tier; unknown → undefined', () => {
  assert.equal(effectiveTier('full_admin'), 5);
  assert.equal(effectiveTier('franchise_manager'), 4);
  assert.equal(effectiveTier('construction_crew'), 1);
  assert.equal(effectiveTier('not_a_role'), undefined);
  assert.equal(effectiveTier(undefined), undefined);
  assert.equal(effectiveTier(null), undefined);
});

test('full_admin apex: only a full_admin may act on / assign a full_admin', () => {
  // full_admin can act on everyone, including another full_admin.
  assert.equal(canActOnTarget('full_admin', 'full_admin'), true);
  assert.equal(canActOnTarget('full_admin', 'franchise_manager'), true);
  assert.equal(canActOnTarget('full_admin', 'construction_crew'), true);
  // A tier-4 franchise_manager CANNOT act on or assign full_admin (apex is above it).
  assert.equal(canActOnTarget('franchise_manager', 'full_admin'), false);
  assert.equal(canAssignRole('franchise_manager', 'full_admin'), false);
  // Lower tiers likewise cannot.
  assert.equal(canActOnTarget('office_manager', 'full_admin'), false);
  // Only full_admin can assign the full_admin role.
  assert.equal(canAssignRole('full_admin', 'full_admin'), true);
});

test('two franchise_managers (same effective tier 4) can still act on each other', () => {
  assert.equal(canActOnTarget('franchise_manager', 'franchise_manager'), true);
  assert.equal(canAssignRole('franchise_manager', 'franchise_manager'), true);
  // And a franchise_manager can still act on / assign everything below apex.
  assert.equal(canActOnTarget('franchise_manager', 'office_manager'), true);
  assert.equal(canAssignRole('franchise_manager', 'production_manager'), true);
});

// Regression guard for the reset-enrollment-code escalation path.
// POST /users/:id/reset-enrollment-code re-arms /auth/set-pin AND returns the
// plaintext code to the caller. It is gated on `manage_users || set_pins`, which
// an hr_manager (tier 3) holds — so without a tier check they could mint an
// enrollment code for a never-signed-in full_admin and take that account.
test('reset-enrollment-code: a set_pins holder cannot act on a higher-tier target', () => {
  // hr_manager (tier 3) holds set_pins but must not touch tier 4 / apex.
  assert.equal(canActOnTarget('hr_manager', 'full_admin'), false);
  assert.equal(canActOnTarget('hr_manager', 'franchise_manager'), false);
  // A franchise_manager (tier 4) is still NOT apex: only full_admin may act on full_admin.
  assert.equal(canActOnTarget('franchise_manager', 'full_admin'), false);
  // Peers and below are fine.
  assert.equal(canActOnTarget('hr_manager', 'office_manager'), true);
  assert.equal(canActOnTarget('hr_manager', 'construction_crew'), true);
  assert.equal(canActOnTarget('full_admin', 'full_admin'), true);
  // Fail closed: an unresolved caller role acts on nobody.
  assert.equal(canActOnTarget(null, 'construction_crew'), false);
  assert.equal(canActOnTarget(undefined, 'temporary_employee'), false);
});

test('media permission family tier defaults mirror the inventory family', () => {
  // add=upload_media (pre-existing), edit_media like edit_inventory,
  // delete_media like delete_inventory (default-granted to tier 4 only).
  assert.equal(userHasPermission('full_admin', null, 'edit_media', null), true);
  assert.equal(userHasPermission('full_admin', null, 'delete_media', null), true);
  assert.equal(userHasPermission('head_of_construction', null, 'edit_media', null), true);  // tier 2
  assert.equal(userHasPermission('head_of_construction', null, 'delete_media', null), false);
  assert.equal(userHasPermission('hr_manager', null, 'edit_media', null), false);           // tier 3
  assert.equal(userHasPermission('construction_crew', null, 'edit_media', null), false);    // tier 1
  assert.equal(userHasPermission('construction_crew', null, 'delete_media', null), false);
  // overrides still apply per the normal resolution chain
  assert.equal(userHasPermission('construction_crew', { edit_media: true }, 'edit_media', null), true);
});

// ── #76: quick_add parity — MUST mirror apps/mobile/src/constants/roles.ts
// ROLE_DEFAULTS exactly (tier4/tier3/tier2 = true, tier1/tempEmployee = false).
// This closes the silent drift that let quick_add gate nothing server-side.

const EXPECTED_QUICK_ADD: Record<string, boolean> = {
  full_admin:               true,
  franchise_manager:        true,
  hr_manager:               true,
  office_manager:           true,
  head_of_construction:     true,
  head_of_contents:         true,
  production_manager:       true,
  carpet_cleaning_manager:  true,
  construction_crew:        false,
  contents_crew:            false,
  mitigation_technician:    false,
  carpet_cleaning_crew:     false,
  duct_cleaning_technician: false,
  temporary_employee:       false,
};

test('quick_add: every ROLE_DEFAULTS role carries a quick_add key matching mobile roles.ts', () => {
  const roles = Object.keys(ROLE_DEFAULTS);
  assert.equal(roles.length, Object.keys(EXPECTED_QUICK_ADD).length);
  for (const role of roles) {
    assert.ok('quick_add' in ROLE_DEFAULTS[role], `${role} is missing a quick_add key`);
    assert.equal(
      userHasPermission(role, null, 'quick_add', null),
      EXPECTED_QUICK_ADD[role],
      `quick_add for ${role} should be ${EXPECTED_QUICK_ADD[role]}`,
    );
  }
});

// ── #76: tempEmployee byte-parity with mobile roles.ts (:261-268) — edit_media
// and delete_media are explicit false (mobile lists them explicitly even
// though tier1 already defaults both to false; this locks that in). ──────────

test('tempEmployee: edit_media and delete_media are false (byte-parity with mobile)', () => {
  assert.equal(userHasPermission('temporary_employee', null, 'edit_media', null), false);
  assert.equal(userHasPermission('temporary_employee', null, 'delete_media', null), false);
});

// ── #76: team-override union layer ────────────────────────────────────────────
// Server has no per-push team context (unlike mobile's hasPermission(teamId)),
// so full per-team parity is impossible. Documented asymmetry: the server
// accepts the UNION of positive grants across every team the caller belongs
// to, for perms on the TEAM_OVERRIDABLE_PERMISSIONS allowlist only. A denial
// in a team override NEVER narrows access below the role/role-override
// baseline — only an explicit TRUE in ANY team's map can grant.

test('team override union: a grant in ANY team the caller belongs to is accepted', () => {
  // construction_crew (tier1) defaults create_jobs=false; a team grant widens it.
  assert.equal(
    userHasPermission('construction_crew', null, 'create_jobs', null, [{ create_jobs: true }]),
    true,
  );
});

test('team override union: denial in one team + grant in another team ⇒ accepted (union, grants-only)', () => {
  assert.equal(
    userHasPermission('construction_crew', null, 'create_jobs', null, [
      { create_jobs: false },
      { create_jobs: true },
    ]),
    true,
  );
});

test('team override union: a denial-only team override never grants (positive grants only)', () => {
  assert.equal(
    userHasPermission('construction_crew', null, 'create_jobs', null, [{ create_jobs: false }]),
    false,
  );
});

test('team override union: no matching key in any team map leaves the baseline unchanged', () => {
  assert.equal(
    userHasPermission('construction_crew', null, 'create_jobs', null, [{ upload_media: true }]),
    false,
  );
});

test('team override union: only consulted for perms on TEAM_OVERRIDABLE_PERMISSIONS — a non-overridable perm ignores team grants', () => {
  assert.ok(!TEAM_OVERRIDABLE_PERMISSIONS.has('manage_teams'), 'test assumption: manage_teams is not team-overridable');
  assert.equal(
    userHasPermission('construction_crew', null, 'manage_teams', null, [{ manage_teams: true }]),
    false,
  );
});

test('team override union: an explicit user-level override always wins over a team grant (matches mobile precedence)', () => {
  assert.equal(
    userHasPermission('construction_crew', { create_jobs: false }, 'create_jobs', null, [{ create_jobs: true }]),
    false,
  );
});

test('team override union: no team memberships (empty/absent list) behaves exactly as before', () => {
  assert.equal(userHasPermission('construction_crew', null, 'create_jobs', null, []), false);
  assert.equal(userHasPermission('construction_crew', null, 'create_jobs', null, null), false);
  assert.equal(userHasPermission('construction_crew', null, 'create_jobs'), false);
});
