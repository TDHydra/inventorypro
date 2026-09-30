import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManageUnitAccess } from './unitAccessPolicy';

const base = {
  callerId: 'caller-1',
  ownerUserId: 'owner-1',
  callerManagesOwnersTeam: false,
  granteeRole: 'mitigation_technician' as string | null,
};

test('the unit OWNER may always manage grants, regardless of role/tier', () => {
  assert.equal(canManageUnitAccess({ ...base, callerId: 'owner-1', callerRole: 'temporary_employee' }), true);
});

test('an ownerless unit does not owner-match a null-ish caller path', () => {
  assert.equal(canManageUnitAccess({ ...base, ownerUserId: null, callerRole: 'construction_crew' }), false);
});

test('a production_manager may grant to a tier-1 grantee', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'production_manager' }), true);
});

test('a production_manager may NOT grant to a full_admin (canActOnTarget tier guard)', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'production_manager', granteeRole: 'full_admin' }), false);
});

test('a manager of a team the owner is on may grant (tier-2 lead, tier-1 grantee)', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'head_of_contents', callerManagesOwnersTeam: true }), true);
});

test('a non-manager tier-2 who does not manage the owner and is not a PM is denied', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'carpet_cleaning_manager' }), false);
});

test('tier-3+ org authority may manage any unit (grantee at/below their tier)', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'office_manager' }), true);
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'full_admin', granteeRole: 'full_admin' }), true);
});

test('unknown grantee role (missing user) fails closed for every non-owner', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'production_manager', granteeRole: null }), false);
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'full_admin', granteeRole: null }), true); // apex out-tiers the fail-closed tier-4 default
});

test('unknown caller role is denied outright (non-owner)', () => {
  assert.equal(canManageUnitAccess({ ...base, callerRole: 'not_a_role' }), false);
  assert.equal(canManageUnitAccess({ ...base, callerRole: null }), false);
});
