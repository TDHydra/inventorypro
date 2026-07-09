import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_TIER, effectiveTier, canActOnTarget, canAssignRole } from './permissions';

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

test('ROLE_TIER mirrors mobile: 13 roles across tiers 1..4', () => {
  const roles = Object.keys(ROLE_TIER);
  assert.equal(roles.length, 13);
  for (const r of roles) assert.ok([1, 2, 3, 4].includes(ROLE_TIER[r]));
  // Spot-check the anchors from apps/mobile/src/constants/roles.ts.
  assert.equal(ROLE_TIER.temporary_employee, 1);
  assert.equal(ROLE_TIER.production_manager, 2);
  assert.equal(ROLE_TIER.hr_manager, 3);
  assert.equal(ROLE_TIER.franchise_manager, 4);
  assert.equal(ROLE_TIER.full_admin, 4);
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
