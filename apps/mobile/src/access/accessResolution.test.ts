import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAccessibleLocationIds,
  canSeeAllUnitsInManage,
  isUnitInventoryBlocked,
  resolveUnitActionPerms,
  resolveMyLead,
  type AccessLockerRow,
  type AccessGrantRow,
  type TeamMemberRow,
  type SubteamMemberRow,
} from './accessResolution';

function input(
  lockers: AccessLockerRow[],
  grants: AccessGrantRow[] = [],
  teamMembers: TeamMemberRow[] = []
) {
  return { lockers, grants, teamMembers };
}

// ------------------------------------------------- getAccessibleLocationIds

test('access: owned locker is accessible with empty grants and no teams', () => {
  const result = getAccessibleLocationIds(
    input([{ id: 'L1', ownerUserId: 'frank' }]),
    'frank'
  );
  assert.deepEqual([...result].sort(), ['L1']);
});

test('access: someone else’s locker is NOT accessible without grant or shared team', () => {
  const result = getAccessibleLocationIds(
    input([{ id: 'L1', ownerUserId: 'frank' }]),
    'matt'
  );
  assert.equal(result.size, 0);
});

test('access: explicit grant makes a locker accessible', () => {
  const result = getAccessibleLocationIds(
    input([{ id: 'L1', ownerUserId: 'frank' }], [{ locationId: 'L1', userId: 'matt' }]),
    'matt'
  );
  assert.deepEqual([...result], ['L1']);
});

test('access: grant pointing at a location not in the lockers array is ignored', () => {
  const result = getAccessibleLocationIds(
    input([{ id: 'L1', ownerUserId: 'frank' }], [{ locationId: 'GHOST', userId: 'matt' }]),
    'matt'
  );
  assert.equal(result.size, 0);
});

test('access: whole parent team sees a teammate’s locker (not just subteam)', () => {
  const result = getAccessibleLocationIds(
    input(
      [{ id: 'L1', ownerUserId: 'frank' }],
      [],
      [
        { teamId: 'T1', userId: 'frank' },
        { teamId: 'T1', userId: 'matt' },
      ]
    ),
    'matt'
  );
  assert.deepEqual([...result], ['L1']);
});

test('access: members of a DIFFERENT team do not get access', () => {
  const result = getAccessibleLocationIds(
    input(
      [{ id: 'L1', ownerUserId: 'frank' }],
      [],
      [
        { teamId: 'T1', userId: 'frank' },
        { teamId: 'T2', userId: 'matt' },
      ]
    ),
    'matt'
  );
  assert.equal(result.size, 0);
});

test('access: multi-team user reaches lockers across all their teams', () => {
  const result = getAccessibleLocationIds(
    input(
      [
        { id: 'L1', ownerUserId: 'frank' }, // T1 owner
        { id: 'L2', ownerUserId: 'sara' }, // T2 owner
        { id: 'L3', ownerUserId: 'omar' }, // T3 owner — matt not on T3
      ],
      [],
      [
        { teamId: 'T1', userId: 'frank' },
        { teamId: 'T2', userId: 'sara' },
        { teamId: 'T3', userId: 'omar' },
        { teamId: 'T1', userId: 'matt' },
        { teamId: 'T2', userId: 'matt' },
      ]
    ),
    'matt'
  );
  assert.deepEqual([...result].sort(), ['L1', 'L2']);
});

test('access: owner not on any team — only the owner and grantees reach it', () => {
  const lockers = [{ id: 'L1', ownerUserId: 'loner' }];
  const teams = [
    { teamId: 'T1', userId: 'frank' },
    { teamId: 'T1', userId: 'matt' },
  ];
  assert.equal(getAccessibleLocationIds(input(lockers, [], teams), 'matt').size, 0);
  assert.deepEqual([...getAccessibleLocationIds(input(lockers, [], teams), 'loner')], ['L1']);
  assert.deepEqual(
    [...getAccessibleLocationIds(input(lockers, [{ locationId: 'L1', userId: 'matt' }], teams), 'matt')],
    ['L1']
  );
});

test('access: ownerless locker is reachable only via explicit grant', () => {
  const lockers = [{ id: 'L1', ownerUserId: null }];
  const teams = [
    { teamId: 'T1', userId: 'frank' },
    { teamId: 'T1', userId: 'matt' },
  ];
  assert.equal(getAccessibleLocationIds(input(lockers, [], teams), 'matt').size, 0);
  assert.deepEqual(
    [...getAccessibleLocationIds(input(lockers, [{ locationId: 'L1', userId: 'matt' }], teams), 'matt')],
    ['L1']
  );
});

test('access: owned + granted + teammate paths union without duplicates', () => {
  const result = getAccessibleLocationIds(
    input(
      [
        { id: 'L1', ownerUserId: 'matt' }, // owned AND granted
        { id: 'L2', ownerUserId: 'frank' }, // teammate AND granted
      ],
      [
        { locationId: 'L1', userId: 'matt' },
        { locationId: 'L2', userId: 'matt' },
      ],
      [
        { teamId: 'T1', userId: 'frank' },
        { teamId: 'T1', userId: 'matt' },
      ]
    ),
    'matt'
  );
  assert.deepEqual([...result].sort(), ['L1', 'L2']);
});

test('access: empty everything yields an empty set', () => {
  assert.equal(getAccessibleLocationIds(input([]), 'matt').size, 0);
});

// ----------------------------------------------- unit visibility (#130, A2)

test('#130: ownerless locker stays invisible day-to-day without a grant', () => {
  const result = getAccessibleLocationIds(input([{ id: 'L1', ownerUserId: null }]), 'matt');
  assert.equal(result.size, 0);
});

test('#130: manage context — tier-3+, PMs, team managers, and unit owners see all', () => {
  assert.ok(canSeeAllUnitsInManage({ roleTier: 4, isTeamManager: false, ownsAnyUnit: false, isProductionManager: false }));
  assert.ok(canSeeAllUnitsInManage({ roleTier: 1, isTeamManager: true, ownsAnyUnit: false, isProductionManager: false }));
  assert.ok(canSeeAllUnitsInManage({ roleTier: 2, isTeamManager: false, ownsAnyUnit: true, isProductionManager: false }));
  // production_manager is tier 2, so the spec's PM callout needs its own fact:
  // a PM who manages no team and owns no unit must STILL see all units here.
  assert.ok(canSeeAllUnitsInManage({ roleTier: 2, isTeamManager: false, ownsAnyUnit: false, isProductionManager: true }));
  assert.ok(!canSeeAllUnitsInManage({ roleTier: 2, isTeamManager: false, ownsAnyUnit: false, isProductionManager: false }));
});

// -------------------------------------------- per-action unit perms (A2 T4)

const NONE = { view: false, add: false, remove: false, move: false, editDetails: false, grant: false };

test('unit perms: owner and tier-3+ get everything', () => {
  for (const p of [
    resolveUnitActionPerms({ isOwner: true, roleTier: 1, isTeammateOfOwner: false, rowPerms: NONE }),
    resolveUnitActionPerms({ isOwner: false, roleTier: 3, isTeammateOfOwner: false, rowPerms: NONE }),
  ]) assert.deepEqual(p, { view: true, add: true, remove: true, move: true, editDetails: true, grant: true });
});

test('unit perms: teammate-of-owner keeps implicit work access, never edit/grant', () => {
  assert.deepEqual(
    resolveUnitActionPerms({ isOwner: false, roleTier: 1, isTeammateOfOwner: true, rowPerms: NONE }),
    { view: true, add: true, remove: true, move: true, editDetails: false, grant: false });
});

test('unit perms: explicit grant unions with teammate fallback; stranger gets row perms only', () => {
  const row = { ...NONE, view: true, editDetails: true };
  assert.deepEqual(
    resolveUnitActionPerms({ isOwner: false, roleTier: 1, isTeammateOfOwner: false, rowPerms: row }),
    { view: true, add: false, remove: false, move: false, editDetails: true, grant: false });
});

// ------------------------------------------------------------ resolveMyLead

const crew = (
  teamId: string,
  userId: string,
  subteamId: string | null,
  subteamRole: string | null
): SubteamMemberRow => ({ teamId, userId, subteamId, subteamRole });

test('resolveMyLead: helper gets their subteam lead', () => {
  const rows = [
    crew('T1', 'frank', 'S1', 'lead'),
    crew('T1', 'matt', 'S1', 'helper'),
    crew('T1', 'sara', 'S2', 'lead'),
  ];
  assert.deepEqual(resolveMyLead(rows, 'matt'), ['frank']);
});

test('resolveMyLead: a lead resolves to themself', () => {
  const rows = [crew('T1', 'frank', 'S1', 'lead'), crew('T1', 'matt', 'S1', 'helper')];
  assert.deepEqual(resolveMyLead(rows, 'frank'), ['frank']);
});

test('resolveMyLead: user with no subteam assignment gets []', () => {
  const rows = [crew('T1', 'frank', 'S1', 'lead'), crew('T1', 'matt', null, null)];
  assert.deepEqual(resolveMyLead(rows, 'matt'), []);
});

test('resolveMyLead: unknown user gets []', () => {
  assert.deepEqual(resolveMyLead([crew('T1', 'frank', 'S1', 'lead')], 'ghost'), []);
});

test('resolveMyLead: leads of OTHER subteams are excluded', () => {
  const rows = [
    crew('T1', 'frank', 'S1', 'lead'),
    crew('T1', 'matt', 'S1', 'helper'),
    crew('T1', 'sara', 'S2', 'lead'),
    crew('T1', 'omar', 'S2', 'helper'),
  ];
  assert.deepEqual(resolveMyLead(rows, 'omar'), ['sara']);
});

test('resolveMyLead: user on multiple subteams gets every lead, deduped', () => {
  const rows = [
    crew('T1', 'frank', 'S1', 'lead'),
    crew('T1', 'matt', 'S1', 'helper'),
    crew('T2', 'frank', 'S2', 'lead'), // frank leads both crews
    crew('T2', 'matt', 'S2', 'helper'),
    crew('T2', 'sara', 'S3', 'lead'),
    crew('T2', 'matt', 'S3', 'helper'),
  ];
  assert.deepEqual(resolveMyLead(rows, 'matt'), ['frank', 'sara']);
});

test('resolveMyLead: subteam with no lead yields [] for its helper', () => {
  const rows = [crew('T1', 'matt', 'S1', 'helper'), crew('T1', 'omar', 'S1', 'helper')];
  assert.deepEqual(resolveMyLead(rows, 'matt'), []);
});

// ------------------------------------------------- isUnitInventoryBlocked (#162)

test('#162: a main (non-unit) location is never blocked', () => {
  assert.equal(isUnitInventoryBlocked({
    isUnit: false, ownerUserId: 'frank', actorSharesOwnerTeam: false, hasCrossTeamPerm: false,
  }), false);
});

test('#162: an ownerless unit is unrestricted', () => {
  assert.equal(isUnitInventoryBlocked({
    isUnit: true, ownerUserId: null, actorSharesOwnerTeam: false, hasCrossTeamPerm: false,
  }), false);
});

test('#162: a same-team (or own) unit is unrestricted', () => {
  assert.equal(isUnitInventoryBlocked({
    isUnit: true, ownerUserId: 'frank', actorSharesOwnerTeam: true, hasCrossTeamPerm: false,
  }), false);
});

test('#162: a foreign-team unit is BLOCKED without the cross-team perm', () => {
  assert.equal(isUnitInventoryBlocked({
    isUnit: true, ownerUserId: 'frank', actorSharesOwnerTeam: false, hasCrossTeamPerm: false,
  }), true);
});

test('#162: manage_other_team_inventory unblocks a foreign-team unit', () => {
  assert.equal(isUnitInventoryBlocked({
    isUnit: true, ownerUserId: 'frank', actorSharesOwnerTeam: false, hasCrossTeamPerm: true,
  }), false);
});
