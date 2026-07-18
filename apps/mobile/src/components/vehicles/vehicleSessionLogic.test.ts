import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCheckoutAction,
  buildClosePayload,
  formatSince,
  waterStateLabel,
  serviceTargetLabel,
} from './vehicleSessionLogic';

const open = (userId: string) => ({ id: 's1', user_id: userId, checked_in_at: null });

test('resolveCheckoutAction: no session → check_out', () => {
  assert.deepEqual(resolveCheckoutAction(null, 'me'), { kind: 'check_out' });
});

test('resolveCheckoutAction: closed session → check_out (stale row is not a holder)', () => {
  assert.deepEqual(
    resolveCheckoutAction({ id: 's1', user_id: 'me', checked_in_at: '2026-07-18T00:00:00Z' }, 'me'),
    { kind: 'check_out' },
  );
});

test('resolveCheckoutAction: my open session → check_in with the session id', () => {
  assert.deepEqual(resolveCheckoutAction(open('me'), 'me'), { kind: 'check_in', sessionId: 's1' });
});

test("resolveCheckoutAction: someone else's open session → take_over with holder", () => {
  assert.deepEqual(resolveCheckoutAction(open('frank'), 'me'), {
    kind: 'take_over', sessionId: 's1', holderId: 'frank',
  });
});

test('resolveCheckoutAction: no current user → take_over (never claims check_in)', () => {
  assert.deepEqual(resolveCheckoutAction(open('frank'), null), {
    kind: 'take_over', sessionId: 's1', holderId: 'frank',
  });
});

test('buildClosePayload: EXACTLY id + checked_in_at + updated_at (server takeover guard shape)', () => {
  const p = buildClosePayload('s1', '2026-07-18T12:00:00.000Z');
  assert.deepEqual(p, {
    id: 's1',
    checked_in_at: '2026-07-18T12:00:00.000Z',
    updated_at: '2026-07-18T12:00:00.000Z',
  });
  // The guard rejects any extra key — pin the exact key set.
  assert.deepEqual(Object.keys(p).sort(), ['checked_in_at', 'id', 'updated_at']);
});

test('formatSince: minutes / hours / days buckets', () => {
  const t0 = '2026-07-18T00:00:00.000Z';
  assert.equal(formatSince(t0, '2026-07-18T00:05:00.000Z'), '5m');
  assert.equal(formatSince(t0, '2026-07-18T02:15:00.000Z'), '2h 15m');
  assert.equal(formatSince(t0, '2026-07-18T03:00:00.000Z'), '3h');
  assert.equal(formatSince(t0, '2026-07-21T04:00:00.000Z'), '3d 4h');
  assert.equal(formatSince(t0, '2026-07-21T00:00:00.000Z'), '3d');
});

test('formatSince: future/garbage input → empty string', () => {
  assert.equal(formatSince('2026-07-19T00:00:00Z', '2026-07-18T00:00:00Z'), '');
  assert.equal(formatSince('not-a-date', '2026-07-18T00:00:00Z'), '');
});

test('labels: water state + service target', () => {
  assert.equal(waterStateLabel('full'), 'Full of water');
  assert.equal(waterStateLabel('empty_clean'), 'Empty + clean tank');
  assert.equal(waterStateLabel(null), '');
  assert.equal(serviceTargetLabel('vehicle'), 'Vehicle');
  assert.equal(serviceTargetLabel('truck_mount'), 'Truck mount');
  assert.equal(serviceTargetLabel('both'), 'Both');
});
