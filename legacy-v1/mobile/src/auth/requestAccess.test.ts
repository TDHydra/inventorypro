import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAccessGrantor, type CandidateRef } from './requestAccess';
import type { Permission, UserRole } from '../constants/roles';

// A tiny fake permission table standing in for the real hasPermission chain —
// findAccessGrantor is DI'd specifically so tests never need to import the
// real one (which pulls in the native DB layer, see requestAccess.ts's header
// comment / useSession.test.ts's identical precedent).
function holdsFrom(table: Record<string, Permission[]>) {
  return (candidate: CandidateRef, permission: Permission): boolean =>
    (table[candidate.id] ?? []).includes(permission);
}

function user(id: string, name: string, role: UserRole): CandidateRef {
  return { id, name, role };
}

const requester = user('me', 'Me', 'construction_crew');

test('prefers someone who holds BOTH the permission and manage_roles_permissions', () => {
  const candidates = [
    user('a', 'Alice', 'head_of_construction'), // holds the permission only
    user('b', 'Bob', 'franchise_manager'),      // holds both
  ];
  const holds = holdsFrom({
    a: ['manage_teams'],
    b: ['manage_teams', 'manage_roles_permissions'],
  });
  const grantor = findAccessGrantor('manage_teams', requester, candidates, holds);
  assert.deepEqual(grantor, { id: 'b', name: 'Bob' });
});

test('falls back to any holder of the permission when nobody holds both', () => {
  const candidates = [
    user('a', 'Alice', 'head_of_construction'),
    user('b', 'Bob', 'franchise_manager'),
  ];
  const holds = holdsFrom({
    a: ['manage_teams'],
    b: ['manage_roles_permissions'], // holds the OTHER permission, not this one
  });
  const grantor = findAccessGrantor('manage_teams', requester, candidates, holds);
  assert.deepEqual(grantor, { id: 'a', name: 'Alice' });
});

test('falls back to a manage_roles_permissions holder when nobody holds the target permission at all', () => {
  const candidates = [
    user('a', 'Alice', 'head_of_construction'),
    user('b', 'Bob', 'franchise_manager'),
  ];
  const holds = holdsFrom({
    b: ['manage_roles_permissions'],
  });
  const grantor = findAccessGrantor('manage_teams', requester, candidates, holds);
  assert.deepEqual(grantor, { id: 'b', name: 'Bob' });
});

test('returns null when nobody holds the permission or manage_roles_permissions', () => {
  const candidates = [user('a', 'Alice', 'head_of_construction')];
  const holds = holdsFrom({});
  assert.equal(findAccessGrantor('manage_teams', requester, candidates, holds), null);
});

test('excludes the current user even if they themself hold the permission', () => {
  const candidates = [user('me', 'Me', 'construction_crew'), user('a', 'Alice', 'head_of_construction')];
  const holds = holdsFrom({ me: ['manage_teams'], a: ['manage_teams'] });
  const grantor = findAccessGrantor('manage_teams', requester, candidates, holds);
  assert.deepEqual(grantor, { id: 'a', name: 'Alice' });
});

test('tie-break: among equal holders, picks the closest role tier to the requester', () => {
  // requester is tier 1 (construction_crew). head_of_construction is tier 2
  // (distance 1); franchise_manager is tier 4 (distance 3).
  const candidates = [
    user('far', 'Far', 'franchise_manager'),
    user('near', 'Near', 'head_of_construction'),
  ];
  const holds = holdsFrom({
    far: ['manage_teams', 'manage_roles_permissions'],
    near: ['manage_teams', 'manage_roles_permissions'],
  });
  const grantor = findAccessGrantor('manage_teams', requester, candidates, holds);
  assert.deepEqual(grantor, { id: 'near', name: 'Near' });
});

test('tie-break: equal tier distance falls back to alphabetical name (deterministic)', () => {
  const candidates = [
    user('z', 'Zed', 'head_of_construction'),
    user('a', 'Amy', 'head_of_construction'),
  ];
  const holds = holdsFrom({
    z: ['manage_teams', 'manage_roles_permissions'],
    a: ['manage_teams', 'manage_roles_permissions'],
  });
  const grantor = findAccessGrantor('manage_teams', requester, candidates, holds);
  assert.deepEqual(grantor, { id: 'a', name: 'Amy' });
});

test('the fallback-only case (SyncIndicator usage): asking for manage_roles_permissions itself just returns its closest holder', () => {
  const candidates = [
    user('a', 'Alice', 'office_manager'),
    user('b', 'Bob', 'franchise_manager'),
  ];
  const holds = holdsFrom({
    a: ['manage_roles_permissions'],
    b: ['manage_roles_permissions'],
  });
  // requester tier 1; office_manager tier 3 (distance 2), franchise_manager tier 4 (distance 3)
  const grantor = findAccessGrantor('manage_roles_permissions', requester, candidates, holds);
  assert.deepEqual(grantor, { id: 'a', name: 'Alice' });
});
