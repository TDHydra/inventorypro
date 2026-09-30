import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formScreenBottomPadding } from './formScreenInsets';

// #118 — FormScreen adds the device's safe-area bottom inset on top of its base
// content padding so the last field / action row clears the gesture nav bar /
// home indicator. This pure helper does the (NaN/negative-guarded) arithmetic.

test('formScreenBottomPadding adds the safe-area inset on top of the base padding', () => {
  assert.equal(formScreenBottomPadding(24, 0), 24); // no inset (e.g. button-nav device)
  assert.equal(formScreenBottomPadding(24, 34), 58); // iOS home indicator
  assert.equal(formScreenBottomPadding(24, 24), 48); // android gesture bar
});

test('formScreenBottomPadding clamps negative/garbage insets to the base', () => {
  assert.equal(formScreenBottomPadding(24, -5), 24);
  assert.equal(formScreenBottomPadding(24, Number.NaN), 24);
  assert.equal(formScreenBottomPadding(24, Number.POSITIVE_INFINITY), 24);
});

test('formScreenBottomPadding works with a zero base', () => {
  assert.equal(formScreenBottomPadding(0, 34), 34);
  assert.equal(formScreenBottomPadding(0, 0), 0);
});
