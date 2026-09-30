// #285: increment/decrement stepping for VerticalLevelSlider's ± buttons and
// its assistive-tech adjust actions. Pure so it's testable without the
// PanResponder — same split as stepTimeMinute (#221), and the same core rule:
// snap onto the caller's grid FIRST, then move one WHOLE step.
//
// Why that rule matters here. The slider commits a raw 0–100 position and lets
// the caller quantize it (VehiclePanel snaps debris and fuel to 10s via
// `Math.round(raw / 10) * 10`). The buttons used to nudge by a hardcoded 5,
// which is exactly half a step — and `Math.round` breaks ties upward, so
// `snap(50 - 5)` is `Math.round(4.5) * 10` = 50. Minus was a no-op at EVERY
// value on the grid while plus always advanced. Stepping by the caller's own
// step size removes the tie entirely.

export function clampLevelPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * One step up (+1) or down (-1) from `value`, on a grid of `step` percent.
 *
 * The snap-first pass only bites on legacy rows written before the callers
 * quantized (a stored 45 steps down to 40, not 35) — everything written since
 * is already on-grid, where snapping is the identity.
 */
export function stepLevelPct(value: number, direction: 1 | -1, step: number): number {
  const s = Number.isFinite(step) && step > 0 ? step : 1;
  const snapped = Math.round(clampLevelPct(value) / s) * s;
  return clampLevelPct(snapped + direction * s);
}
