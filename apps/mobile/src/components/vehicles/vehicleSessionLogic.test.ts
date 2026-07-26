import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCheckoutAction,
  buildClosePayload,
  formatSince,
  waterTankLabel,
  wasteTankLabel,
  serviceTargetLabel,
  buildTakeoverNote,
  buildFuelUpNotes,
  parseFuelUpGallons,
  serviceTypeLabel,
  odometerDeltas,
  resolveVehicleAvailability,
  canLiftVehicleLock,
  snapDebrisLevel,
  buildReceiptVehicleMismatchNote,
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

test('waterTankLabel maps full/empty and blanks unknowns', () => {
  assert.equal(waterTankLabel('full'), 'Water: full');
  assert.equal(waterTankLabel('empty'), 'Water: empty');
  assert.equal(waterTankLabel(null), '');
  assert.equal(waterTankLabel('empty_clean'), ''); // legacy value never reaches labels
});

test('wasteTankLabel maps clean/dirty and blanks unknowns', () => {
  assert.equal(wasteTankLabel('clean'), 'Waste: clean');
  assert.equal(wasteTankLabel('dirty'), 'Waste: dirty');
  assert.equal(wasteTankLabel(undefined), '');
});

test('labels: service target', () => {
  assert.equal(serviceTargetLabel('vehicle'), 'Vehicle');
  assert.equal(serviceTargetLabel('truck_mount'), 'Truck mount');
  assert.equal(serviceTargetLabel('both'), 'Both');
});

// ── #141: takeover audit note ───────────────────────────────────────────────

test('buildTakeoverNote names the prior driver, checkout time and duration', () => {
  assert.equal(
    buildTakeoverNote('Frank', '2026-07-19T08:00:00.000Z', '2026-07-19T11:15:00.000Z'),
    'took over from Frank (out since 2026-07-19T08:00:00.000Z, 3h 15m)',
  );
});

test('buildTakeoverNote survives an unknown holder and a zero duration', () => {
  assert.equal(
    buildTakeoverNote(null, '2026-07-19T08:00:00.000Z', '2026-07-19T08:00:00.000Z'),
    'took over from unknown driver (out since 2026-07-19T08:00:00.000Z, 0m)',
  );
});

// ── #141: fuel-up notes round-trip (gallons live in the TEXT notes column) ──

test('buildFuelUpNotes prefixes gallons and keeps free text', () => {
  assert.equal(buildFuelUpNotes(12.5, 'topped off'), '12.5 gal — topped off');
  assert.equal(buildFuelUpNotes(12.5, ''), '12.5 gal');
  assert.equal(buildFuelUpNotes(null, 'no pump reading'), 'no pump reading');
  assert.equal(buildFuelUpNotes(null, ''), null);
});

test('parseFuelUpGallons reads the prefix back (and only the prefix)', () => {
  assert.equal(parseFuelUpGallons('12.5 gal — topped off'), 12.5);
  assert.equal(parseFuelUpGallons('8 gal'), 8);
  assert.equal(parseFuelUpGallons('no pump reading'), null);
  assert.equal(parseFuelUpGallons(null), null);
});

// ── #141: service-type display label ────────────────────────────────────────

test('serviceTypeLabel maps fuel_up, passes through everything else', () => {
  assert.equal(serviceTypeLabel('fuel_up'), 'Fuel-up');
  assert.equal(serviceTypeLabel('Oil change'), 'Oil change');
});

// ── #141: odometer deltas (rows newest-first) ───────────────────────────────

test('odometerDeltas: each row minus the next-older reading, oldest is null', () => {
  const rows = [{ odometer: 84500 }, { odometer: 84200 }, { odometer: 84000 }];
  assert.deepEqual(odometerDeltas(rows), [300, 200, null]);
  assert.deepEqual(odometerDeltas([]), []);
});

// ── #167: locked_by stamping (phase 0 — write plumbing only, rule comes later)
import { resolveLockStamp } from './vehicleSessionLogic';

test('resolveLockStamp: 0→1 stamps the acting user', () => {
  assert.equal(resolveLockStamp({ checkout_locked: 1 }, { checkout_locked: 0, locked_by: null }, 'u-1'), 'u-1');
  assert.equal(resolveLockStamp({ checkout_locked: 1 }, null, 'u-1'), 'u-1');
});

test('resolveLockStamp: 1→1 keeps the original locker', () => {
  assert.equal(resolveLockStamp({ checkout_locked: 1 }, { checkout_locked: 1, locked_by: 'u-orig' }, 'u-2'), 'u-orig');
});

test('resolveLockStamp: 1→1 legacy lock (NULL locker) adopts the acting user', () => {
  assert.equal(resolveLockStamp({ checkout_locked: 1 }, { checkout_locked: 1, locked_by: null }, 'u-2'), 'u-2');
});

test('resolveLockStamp: →0 clears; untouched patch carries existing', () => {
  assert.equal(resolveLockStamp({ checkout_locked: 0 }, { checkout_locked: 1, locked_by: 'u-orig' }, 'u-2'), null);
  assert.equal(resolveLockStamp({}, { checkout_locked: 1, locked_by: 'u-orig' }, 'u-2'), 'u-orig');
  assert.equal(resolveLockStamp({}, null, 'u-2'), null);
});

// ── #155: availability ───────────────────────────────────────────────────────
test('availability: open session wins over everything → checked_out', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: 'me', openCheckout: 1, hasOpenSession: true, userId: 'me' }),
    { available: false, reason: 'checked_out' },
  );
});

test('availability: unowned + free → available', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: null, openCheckout: 0, hasOpenSession: false, userId: 'me' }),
    { available: true, reason: null },
  );
});

test('availability: owned, closed, not mine → owned_closed', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: 'frank', openCheckout: 0, hasOpenSession: false, userId: 'me' }),
    { available: false, reason: 'owned_closed' },
  );
});

test('availability: owned but opted in → available', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: 'frank', openCheckout: 1, hasOpenSession: false, userId: 'me' }),
    { available: true, reason: null },
  );
});

test('availability: my own vehicle is always available to me when free', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: 'me', openCheckout: 0, hasOpenSession: false, userId: 'me' }),
    { available: true, reason: null },
  );
});

test('availability: anonymous user does not match a null owner', () => {
  assert.deepEqual(
    resolveVehicleAvailability({ ownerUserId: 'frank', openCheckout: 0, hasOpenSession: false, userId: null }),
    { available: false, reason: 'owned_closed' },
  );
});

// ── #167: lock lift (tiers: 1 crew / 2 PM / 3 office / 4 admin) ─────────────
const lift = (over: Partial<Parameters<typeof canLiftVehicleLock>[0]>) =>
  canLiftVehicleLock({ canManage: true, lockedBy: 'pm', lockerTier: 2, userId: 'me', userTier: 1, ...over });

test('lift: no manage authority → never', () => {
  assert.equal(lift({ canManage: false, userTier: 4 }), false);
});

test('lift: legacy NULL locker → any manager may lift', () => {
  assert.equal(lift({ lockedBy: null, lockerTier: 0 }), true);
});

test('lift: self-lock → may lift regardless of tier', () => {
  assert.equal(lift({ lockedBy: 'me', lockerTier: 4, userTier: 1 }), true);
});

test('lift: crew owner vs PM lock → blocked (the #167 case)', () => {
  assert.equal(lift({ userTier: 1, lockerTier: 2 }), false);
});

test('lift: equal tier → allowed', () => {
  assert.equal(lift({ userTier: 2, lockerTier: 2 }), true);
});

test('lift: higher tier → allowed', () => {
  assert.equal(lift({ userTier: 3, lockerTier: 2 }), true);
});

test('lift: deleted locker resolves to tier 0 → any manager may lift', () => {
  assert.equal(lift({ lockedBy: 'ghost', lockerTier: 0, userTier: 1 }), true);
});

// ── #152: debris snap ────────────────────────────────────────────────────────
test('snapDebrisLevel: rounds to nearest 10 and clamps', () => {
  assert.equal(snapDebrisLevel(0), 0);
  assert.equal(snapDebrisLevel(14.9), 10);
  assert.equal(snapDebrisLevel(15), 20);
  assert.equal(snapDebrisLevel(73), 70);
  assert.equal(snapDebrisLevel(104), 100);
  assert.equal(snapDebrisLevel(-3), 0);
  assert.equal(snapDebrisLevel(NaN), 0);
});

// ── #168: receipt logged against a different vehicle than the active checkout
test('buildReceiptVehicleMismatchNote names both vehicles', () => {
  assert.equal(
    buildReceiptVehicleMismatchNote('Van 1', 'Box Truck'),
    'fuel_up receipt: user checked out Van 1 but logged against Box Truck',
  );
});
