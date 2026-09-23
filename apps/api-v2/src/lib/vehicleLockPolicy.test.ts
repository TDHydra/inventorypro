import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canChangeVehicleLock } from './vehicleLockPolicy';

// currentLockedBy: null isolates the canManageVehicle stage (the lift stage
// collapses to true), mirroring apps/mobile/src/db/queries/access.test.ts's
// canManageVehicle truth table exactly.
const manageBase = {
  callerId: 'crew-owner',
  callerTier: 1,
  ownerUserId: 'crew-owner',
  sharesTeamWithOwner: false,
  currentLockedBy: null as string | null,
  lockedByTier: 0,
};

test('canManageVehicle mirror: owner manages own vehicle regardless of tier', () => {
  assert.equal(canChangeVehicleLock({ ...manageBase, callerId: 'crew-owner', ownerUserId: 'crew-owner', callerTier: 1 }), true);
});

test('canManageVehicle mirror: tier-3 office manager manages ANY vehicle', () => {
  assert.equal(canChangeVehicleLock({ ...manageBase, callerId: 'om-1', ownerUserId: 'someone-else', callerTier: 3 }), true);
  assert.equal(canChangeVehicleLock({ ...manageBase, callerId: 'om-1', ownerUserId: null, callerTier: 3 }), true);
});

test('canManageVehicle mirror: tier-2 PM manages a vehicle owned by a teammate', () => {
  assert.equal(canChangeVehicleLock({ ...manageBase, callerId: 'pm-1', ownerUserId: 'tech-owner', callerTier: 2, sharesTeamWithOwner: true }), true);
});

test('canManageVehicle mirror: tier-2 PM does NOT manage other-team or unowned vehicles', () => {
  assert.equal(canChangeVehicleLock({ ...manageBase, callerId: 'pm-1', ownerUserId: 'stranger', callerTier: 2, sharesTeamWithOwner: false }), false);
  assert.equal(canChangeVehicleLock({ ...manageBase, callerId: 'pm-1', ownerUserId: null, callerTier: 2, sharesTeamWithOwner: false }), false);
});

test('canManageVehicle mirror: tier-1 crew non-owner never manages', () => {
  assert.equal(canChangeVehicleLock({ ...manageBase, callerId: 'crew-2', ownerUserId: 'tech-owner', callerTier: 1, sharesTeamWithOwner: true }), false);
});

// canManage forced true (owner) so these isolate the canLiftVehicleLock stage,
// mirroring vehicleSessionLogic.test.ts's `lift()` truth table exactly.
const liftBase = {
  callerId: 'me',
  callerTier: 1,
  ownerUserId: 'me', // owner → canManage always true
  sharesTeamWithOwner: false,
  currentLockedBy: 'pm' as string | null,
  lockedByTier: 2,
};

test('canLiftVehicleLock mirror: no manage authority → never', () => {
  assert.equal(canChangeVehicleLock({ ...liftBase, ownerUserId: null, callerTier: 1, sharesTeamWithOwner: false }), false);
});

test('canLiftVehicleLock mirror: legacy NULL locker → any manager may lift', () => {
  assert.equal(canChangeVehicleLock({ ...liftBase, currentLockedBy: null, lockedByTier: 0 }), true);
});

test('canLiftVehicleLock mirror: self-lock → may lift regardless of tier', () => {
  assert.equal(canChangeVehicleLock({ ...liftBase, currentLockedBy: 'me', lockedByTier: 4, callerTier: 1 }), true);
});

test('canLiftVehicleLock mirror: crew owner vs PM lock → blocked (the #167 case)', () => {
  assert.equal(canChangeVehicleLock({ ...liftBase, callerTier: 1, currentLockedBy: 'pm', lockedByTier: 2 }), false);
});

test('canLiftVehicleLock mirror: equal tier → allowed', () => {
  assert.equal(canChangeVehicleLock({ ...liftBase, callerTier: 2, currentLockedBy: 'pm', lockedByTier: 2 }), true);
});

test('null args-equivalent: no owner match, no team share, low tier → denied', () => {
  assert.equal(canChangeVehicleLock({
    callerId: 'crew-2', callerTier: 1, ownerUserId: 'tech-owner',
    sharesTeamWithOwner: false, currentLockedBy: null, lockedByTier: 0,
  }), false);
});
