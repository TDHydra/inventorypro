// Small helper for #118 (app-wide keyboard-aware forms): reconcile the bottom
// safe-area inset with a form screen's base content padding, so the last field
// / action button clears the gesture nav bar / home indicator instead of
// sitting underneath it. Kept as a pure module (no React/RN imports) so it can
// be unit-tested under `node --test`.
//
// Lives under src/ (NOT app/) on purpose: Expo Router globs every file under
// app/ into the route bundle, so a co-located *.test.ts importing `node:test`
// there breaks the whole Metro build. Mirrors src/chat/composerInsets.ts.

function guardedInset(insetBottom: number): number {
  // Guard against NaN / negative values coming out of useSafeAreaInsets().
  return Number.isFinite(insetBottom) && insetBottom > 0 ? insetBottom : 0;
}

/**
 * Bottom padding for a FormScreen's scroll content: the theme/base padding plus
 * the device's safe-area bottom inset, so the last field or the (non-sticky)
 * save button clears the gesture nav bar / home indicator.
 */
export function formScreenBottomPadding(base: number, insetBottom: number): number {
  return base + guardedInset(insetBottom);
}
