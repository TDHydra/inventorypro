import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampLevelPct, stepLevelPct } from './levelStep';

// The caller's quantizer, copied from VehiclePanel's snapDebrisLevel /
// snapFuelLevel. The bug only shows up in the round trip THROUGH it, so the
// regression tests below compose the two rather than testing stepping alone.
const snapTo10 = (raw: number) => Math.min(100, Math.max(0, Math.round(raw / 10) * 10));

test('clampLevelPct pins to 0–100 and treats non-finite as 0', () => {
  assert.equal(clampLevelPct(-20), 0);
  assert.equal(clampLevelPct(140), 100);
  assert.equal(clampLevelPct(37), 37);
  assert.equal(clampLevelPct(NaN), 0);
});

test('REGRESSION #285: a minus press LOWERS the committed level at every step', () => {
  // The whole bug: with a hardcoded 5 against a 10s grid, snap(v - 5) rounded
  // half UP and returned v, so minus was a no-op at every on-grid value.
  for (let v = 10; v <= 100; v += 10) {
    const committed = snapTo10(stepLevelPct(v, -1, 10));
    assert.equal(committed, v - 10, `minus from ${v}% should commit ${v - 10}%`);
  }
});

test('a plus press raises the committed level by one whole step', () => {
  for (let v = 0; v <= 90; v += 10) {
    assert.equal(snapTo10(stepLevelPct(v, 1, 10)), v + 10);
  }
});

test('stepping saturates at the ends instead of wrapping or overshooting', () => {
  assert.equal(stepLevelPct(0, -1, 10), 0);
  assert.equal(stepLevelPct(100, 1, 10), 100);
  assert.equal(stepLevelPct(100, -1, 10), 90);
  assert.equal(stepLevelPct(0, 1, 10), 10);
});

test('an off-grid legacy value is pulled onto the grid, then stepped', () => {
  // Rows written before the callers quantized can sit anywhere. 45 belongs to
  // the 50 cell, so one press down is 40 — not 35, which would leave the value
  // off-grid forever.
  assert.equal(stepLevelPct(45, -1, 10), 40);
  assert.equal(stepLevelPct(44, -1, 10), 30);
  assert.equal(stepLevelPct(45, 1, 10), 60);
});

test('out-of-range and non-finite inputs still produce a usable level', () => {
  assert.equal(stepLevelPct(-30, 1, 10), 10);
  assert.equal(stepLevelPct(150, -1, 10), 90);
  assert.equal(stepLevelPct(NaN, -1, 10), 0);
  // A nonsense step must not divide by zero or freeze the control.
  assert.equal(stepLevelPct(50, -1, 0), 49);
  assert.equal(stepLevelPct(50, -1, NaN), 49);
});

test('the step is configurable, so a 25s-grid caller moves 25 at a time', () => {
  assert.equal(stepLevelPct(50, -1, 25), 25);
  assert.equal(stepLevelPct(50, 1, 25), 75);
});
