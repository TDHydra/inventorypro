import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFallbackFullAdmin } from './fallbackGrantor';
// Type-only, same rationale as requestAccess.test.ts.
import type { CandidateRef } from './requestAccess';

const requester: CandidateRef = { id: 'u1', name: 'Requester', role: 'mitigation_technician' };

test('pickFallbackFullAdmin: no candidates -> null', () => {
  assert.equal(pickFallbackFullAdmin([], requester.id), null);
});

test('pickFallbackFullAdmin: no full_admin in the pool -> null', () => {
  const pool: CandidateRef[] = [
    requester,
    { id: 'u2', name: 'Peer', role: 'mitigation_technician' },
  ];
  assert.equal(pickFallbackFullAdmin(pool, requester.id), null);
});

test('pickFallbackFullAdmin: excludes the requester even if they are a full_admin', () => {
  const admin: CandidateRef = { id: 'u1', name: 'Self Admin', role: 'full_admin' };
  assert.equal(pickFallbackFullAdmin([admin], admin.id), null);
});

test('pickFallbackFullAdmin: picks the only other active full_admin', () => {
  const pool: CandidateRef[] = [
    requester,
    { id: 'u3', name: 'Zed Admin', role: 'full_admin' },
  ];
  const grantor = pickFallbackFullAdmin(pool, requester.id);
  assert.deepEqual(grantor, { id: 'u3', name: 'Zed Admin' });
});

test('pickFallbackFullAdmin: multiple full_admins -> deterministic alphabetical-by-name pick', () => {
  const pool: CandidateRef[] = [
    requester,
    { id: 'u3', name: 'Zed Admin', role: 'full_admin' },
    { id: 'u4', name: 'Amy Admin', role: 'full_admin' },
  ];
  const grantor = pickFallbackFullAdmin(pool, requester.id);
  assert.deepEqual(grantor, { id: 'u4', name: 'Amy Admin' });
});
