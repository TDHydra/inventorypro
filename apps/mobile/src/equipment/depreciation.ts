// Pure book-value / depreciation math for equipment units. No React-Native
// imports so it stays trivially unit-testable and safe to import from web too.
//
// Behind the view_financial_data permission at every call site — this module
// itself does NO permission checks; callers gate it.

// Average milliseconds in a calendar month (365.25 / 12 days). Depreciation is
// coarse-grained enough that a fixed average is fine and avoids month-length
// drift over a multi-year life.
const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000;

/** The financial fields computeBookValue needs — a structural subset of EquipmentUnit. */
export interface DepreciableUnit {
  purchase_price: number | null;
  acquired_at: string | null;
  useful_life_months: number | null;
  salvage_value: number | null;
  depreciation_method: string | null;
}

/**
 * Current book value of a unit as of `asOfIso`, or null when it can't/shouldn't
 * be computed:
 *   - method is 'none', null, or unrecognised
 *   - insufficient data (no purchase_price, no acquired_at, or no useful life)
 *
 * straight_line       — linear from purchase_price down to salvage_value over
 *                        useful_life_months, clamped at salvage (never below,
 *                        never above cost).
 * declining_balance   — double-declining: monthly rate 2/useful_life_months
 *                        applied from acquired_at, floored at salvage_value.
 * units_of_production — no usage data here, so fall back to straight_line.
 */
export function computeBookValue(unit: DepreciableUnit, asOfIso: string): number | null {
  const method = unit.depreciation_method;
  if (!method || method === 'none') return null;

  const cost = unit.purchase_price;
  const acquired = unit.acquired_at;
  const life = unit.useful_life_months;
  // Need a cost basis, an acquisition date, and a positive useful life.
  if (cost == null || acquired == null || life == null || life <= 0) return null;

  const acquiredMs = Date.parse(acquired);
  const asOfMs = Date.parse(asOfIso);
  if (isNaN(acquiredMs) || isNaN(asOfMs)) return null;

  const salvage = unit.salvage_value ?? 0;

  // Months since acquisition, never negative (asking about a date before we
  // owned it → treat as brand new, full cost).
  const monthsElapsed = Math.max(0, (asOfMs - acquiredMs) / MS_PER_MONTH);

  let value: number;
  if (method === 'declining_balance') {
    // Double-declining balance. Clamp the retained-value factor to [0,1] so a
    // degenerate short life (rate ≥ 1) collapses to salvage instead of
    // oscillating negative.
    const rate = 2 / life;
    const factor = Math.max(0, Math.min(1, 1 - rate));
    value = cost * Math.pow(factor, monthsElapsed);
    return Math.max(salvage, value);
  }

  // straight_line (and units_of_production fallback).
  const perMonth = (cost - salvage) / life;
  value = cost - perMonth * monthsElapsed;
  // Clamp into [salvage, cost].
  return Math.min(cost, Math.max(salvage, value));
}

/** Format a number as USD currency, e.g. 1234.5 → "$1,234.50". */
export function formatMoney(amount: number): string {
  const neg = amount < 0;
  const abs = Math.abs(amount);
  const [whole, frac] = abs.toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${grouped}.${frac}`;
}
