import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepTimeMinute } from './timeWheelStep';

test('steps forward and backward by stepMinutes', () => {
  assert.equal(stepTimeMinute(480, 1, 300, 1260, 30), 510);
  assert.equal(stepTimeMinute(480, -1, 300, 1260, 30), 450);
});

test('clamps at the range bounds', () => {
  assert.equal(stepTimeMinute(1260, 1, 300, 1260, 30), 1260);
  assert.equal(stepTimeMinute(300, -1, 300, 1260, 30), 300);
});

test('snaps an off-grid value onto the step grid before stepping', () => {
  // 475 is not a multiple of 30 past min=300; nearest grid point is 480.
  assert.equal(stepTimeMinute(475, 1, 300, 1260, 30), 510);
  assert.equal(stepTimeMinute(475, -1, 300, 1260, 30), 450);
});

test('pulls an out-of-range value to the nearest bound as the step', () => {
  assert.equal(stepTimeMinute(60, 1, 300, 1260, 30), 300);
  assert.equal(stepTimeMinute(2000, -1, 300, 1260, 30), 1260);
});
