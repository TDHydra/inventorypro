// #221: accessibility increment/decrement stepping for TimeWheelPicker.
// Pure so it's testable without the wheel; values are minutes-since-midnight
// on the picker's [minMinute, maxMinute] grid of stepMinutes.

export function stepTimeMinute(
  valueMinute: number,
  direction: 1 | -1,
  minMinute: number,
  maxMinute: number,
  stepMinutes: number,
): number {
  // Snap onto the option grid first — a stored value that drifted off-grid
  // would otherwise never match a wheel option after stepping.
  const snapped = minMinute + Math.round((valueMinute - minMinute) / stepMinutes) * stepMinutes;
  // An out-of-range value's "step" is the pull back to the nearest bound —
  // never skip past the first/last option.
  if (snapped < minMinute) return minMinute;
  if (snapped > maxMinute) return maxMinute;
  const next = snapped + direction * stepMinutes;
  return Math.min(maxMinute, Math.max(minMinute, next));
}
