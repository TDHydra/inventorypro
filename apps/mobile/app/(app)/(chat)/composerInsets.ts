// Small chat-local helper for #89(b): reconcile the bottom safe-area inset with
// the message composer's padding and the KeyboardAvoidingView offset. Kept as a
// pure module (no React/RN imports) so it can be unit-tested under `node --test`.

function safeInset(insetBottom: number): number {
  // Guard against NaN / negative values coming out of useSafeAreaInsets().
  return Number.isFinite(insetBottom) && insetBottom > 0 ? insetBottom : 0;
}

/**
 * Bottom padding for the composer: the existing base padding plus the device's
 * safe-area inset, so the composer clears the gesture nav bar / home indicator
 * instead of sitting underneath it.
 */
export function composerBottomPadding(base: number, insetBottom: number): number {
  return base + safeInset(insetBottom);
}

/**
 * keyboardVerticalOffset for the chat KeyboardAvoidingView. The composer already
 * reserves `insetBottom` of bottom padding (see composerBottomPadding); when the
 * keyboard opens on iOS (`padding` behaviour) that reserved space would show as a
 * gap above the keyboard, so fold the inset back out of the header offset to keep
 * the input snug against the keyboard.
 */
export function chatKeyboardVerticalOffset(headerOffset: number, insetBottom: number): number {
  return headerOffset - safeInset(insetBottom);
}
