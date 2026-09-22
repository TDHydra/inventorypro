// Pure numeric helpers behind `QuantityStepper` — kept in a plain (non-.tsx)
// file with zero react/react-native imports so they can be unit-tested under
// node:test without pulling in RN's Flow-syntax internals via the tsx loader.

/** Clamp `n` into [min, max], tolerating an undefined max (no upper bound). */
export function clampQuantity(n: number, min: number, max?: number): number {
  let out = n;
  if (out < min) out = min;
  if (max != null && out > max) out = max;
  return out;
}

/**
 * Parse free-typed text into a clamped numeric value, or null when the text
 * isn't a valid number (caller should reject/ignore rather than commit).
 * Rejects non-numeric input (e.g. "abc"); a bare "-" or "" also returns null.
 */
export function parseQuantityInput(
  text: string,
  min: number,
  max: number | undefined,
  allowDecimal: boolean,
): number | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '-') return null;
  const pattern = allowDecimal ? /^-?\d*\.?\d*$/ : /^-?\d+$/;
  if (!pattern.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return clampQuantity(n, min, max);
}
