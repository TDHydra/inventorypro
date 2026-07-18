import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composerBottomPadding, chatKeyboardVerticalOffset } from './composerInsets';

// #89(b) — the chat composer is overlapped by the gesture nav bar / home
// indicator. These two pure helpers reconcile the safe-area bottom inset with
// the existing KeyboardAvoidingView keyboardVerticalOffset so the composer
// clears the nav bar when the keyboard is closed AND stays snug against the
// keyboard when it opens.

test('composerBottomPadding adds the safe-area inset on top of the base padding', () => {
  assert.equal(composerBottomPadding(8, 0), 8); // no inset (e.g. button-nav device)
  assert.equal(composerBottomPadding(8, 34), 42); // home indicator
  assert.equal(composerBottomPadding(8, 24), 32); // android gesture bar
});

test('composerBottomPadding clamps negative/garbage insets to the base', () => {
  assert.equal(composerBottomPadding(8, -5), 8);
  assert.equal(composerBottomPadding(8, Number.NaN), 8);
});

test('chatKeyboardVerticalOffset folds the inset out so no gap opens above the keyboard', () => {
  assert.equal(chatKeyboardVerticalOffset(90, 0), 90); // no inset -> unchanged
  assert.equal(chatKeyboardVerticalOffset(90, 34), 56); // inset already padded by the composer
});

test('chatKeyboardVerticalOffset clamps negative/garbage insets', () => {
  assert.equal(chatKeyboardVerticalOffset(90, -5), 90);
  assert.equal(chatKeyboardVerticalOffset(90, Number.NaN), 90);
});
