// #147: quantity input math for the checkout qty step. The source location's
// on-hand quantity is a hard ceiling — typing and the −/+ steppers can never
// exceed it. Pure (no React/DB imports) so it unit-tests in plain Node.

/** Round away binary-float noise (0.1 + 1 → 1.1, not 1.1000000000000001). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Sanitize a typed quantity: digits and one dot only, capped at `max`.
 * Partial input ('', '.', '1.') passes through so typing decimals works.
 */
export function clampQtyInput(text: string, max: number | null): string {
  let clean = text.replace(/[^0-9.]/g, '');
  const firstDot = clean.indexOf('.');
  if (firstDot !== -1) {
    clean = clean.slice(0, firstDot + 1) + clean.slice(firstDot + 1).replace(/\./g, '');
  }
  const n = parseFloat(clean);
  if (!isNaN(n) && max != null && n > max) return String(round3(max));
  return clean;
}

/**
 * Step the quantity by `delta` (−/+ buttons), clamped to [lower, max] where
 * lower is 1 — or `max` itself when the source holds less than 1 unit.
 */
export function stepQty(current: string, delta: number, max: number | null): string {
  const base = parseFloat(current);
  let next = (isNaN(base) ? 0 : base) + delta;
  const lower = max != null ? Math.min(1, max) : 1;
  if (next < lower) next = lower;
  if (max != null && next > max) next = max;
  return String(round3(next));
}
