// #217: shared touch-target extension for small kit controls (chips, ± steppers,
// the sync dot). One constant so the slop is consistent — and findable — across
// the kit instead of ad-hoc per-file values. 8px matches the largest ad-hoc
// slops already in use (PreviewBanner, EditMyDashboardSheet).
export const KIT_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
