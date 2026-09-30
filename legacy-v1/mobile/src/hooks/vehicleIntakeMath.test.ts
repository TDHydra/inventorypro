import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMeters,
  isWithinRadius,
  nearestWithinRadius,
  VEHICLE_INTAKE_RADIUS_M,
} from './vehicleIntakeMath';

// Reference points around the office anchor. 1° of latitude ≈ 111,195 m, so a
// latitude offset of X° is ≈ X * 111195 m — used to place points at known
// distances from HERE without an external geo fixture.
const HERE = { latitude: 40.0, longitude: -74.5 };
const at = (latOffsetDeg: number) => ({ latitude: HERE.latitude + latOffsetDeg, longitude: HERE.longitude });

test('haversineMeters: one degree of latitude is ~111.2 km', () => {
  const d = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
  assert.ok(Math.abs(d - 111195) < 100, `expected ~111195m, got ${d}`);
});

test('haversineMeters: zero for identical points', () => {
  assert.equal(haversineMeters(HERE, { ...HERE }), 0);
});

test('haversineMeters: symmetric', () => {
  const b = { latitude: 40.7128, longitude: -74.006 };
  assert.ok(Math.abs(haversineMeters(HERE, b) - haversineMeters(b, HERE)) < 1e-6);
});

test('isWithinRadius: true inside the default 150m radius', () => {
  // 0.0013° lat ≈ 144.6m — just inside.
  assert.equal(isWithinRadius(HERE, at(0.0013)), true);
});

test('isWithinRadius: false just outside the default radius', () => {
  // 0.0014° lat ≈ 155.7m — just outside 150m.
  assert.equal(isWithinRadius(HERE, at(0.0014)), false);
});

test('isWithinRadius: default radius is 150m', () => {
  assert.equal(VEHICLE_INTAKE_RADIUS_M, 150);
});

test('isWithinRadius: honours a custom radius', () => {
  const far = at(0.0014); // ~155.7m
  assert.equal(isWithinRadius(HERE, far, 200), true);
  assert.equal(isWithinRadius(HERE, far, 100), false);
});

test('isWithinRadius: exact boundary counts as within (<=)', () => {
  const d = haversineMeters(HERE, at(0.001));
  assert.equal(isWithinRadius(HERE, at(0.001), d), true);
});

test('isWithinRadius: null device fix → false', () => {
  assert.equal(isWithinRadius(null, HERE), false);
  assert.equal(isWithinRadius(undefined, HERE), false);
});

test('isWithinRadius: un-anchored location (null coords) → false', () => {
  assert.equal(isWithinRadius(HERE, null), false);
  assert.equal(isWithinRadius(HERE, { latitude: null, longitude: null }), false);
  assert.equal(isWithinRadius(HERE, { latitude: 40.0, longitude: null }), false);
  assert.equal(isWithinRadius(HERE, { latitude: undefined, longitude: -74.5 }), false);
});

test('isWithinRadius: non-finite coords degrade to false, never throw', () => {
  assert.equal(isWithinRadius({ latitude: NaN, longitude: 0 }, HERE), false);
  assert.equal(isWithinRadius(HERE, { latitude: Infinity, longitude: 0 }), false);
});

test('nearestWithinRadius: picks the closest candidate inside the radius', () => {
  const near = { id: 'near', ...at(0.0004) };   // ~44m
  const nearer = { id: 'nearer', ...at(0.0002) }; // ~22m
  const far = { id: 'far', ...at(0.01) };        // ~1.1km
  assert.equal(nearestWithinRadius(HERE, [near, far, nearer])?.id, 'nearer');
});

test('nearestWithinRadius: skips candidates without coords', () => {
  const unanchored = { id: 'unanchored', latitude: null, longitude: null };
  const near = { id: 'near', ...at(0.0004) };
  assert.equal(nearestWithinRadius(HERE, [unanchored, near])?.id, 'near');
});

test('nearestWithinRadius: null when nothing is inside the radius', () => {
  assert.equal(nearestWithinRadius(HERE, [{ id: 'far', ...at(0.01) }]), null);
  assert.equal(nearestWithinRadius(HERE, []), null);
});

test('nearestWithinRadius: null device fix → null even with near candidates', () => {
  assert.equal(nearestWithinRadius(null, [{ id: 'near', ...at(0.0001) }]), null);
});

test('nearestWithinRadius: tie keeps the earlier candidate (stable)', () => {
  const a = { id: 'a', ...at(0.0003) };
  const b = { id: 'b', ...at(0.0003) };
  assert.equal(nearestWithinRadius(HERE, [a, b])?.id, 'a');
});
