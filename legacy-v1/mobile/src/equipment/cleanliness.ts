/**
 * Pure cadence math behind equipment/item cleanliness ("filth") state (#248).
 *
 * `cleanliness` is a free-form TEXT column on equipment_units (house rule: no
 * Postgres ENUM on synced columns) — today it's only ever 'clean' or 'dirty',
 * but nothing here assumes that's the whole set. `jobs_since_clean` is a
 * counter incremented client-side at every job check-in, offline-first, with
 * NO server trigger — a direct API write bypasses this cadence entirely (an
 * accepted gap; see the plan). `clean_after_jobs` lives on the ITEM (not the
 * unit) and is re-read at commit time by the caller, never cached at scan
 * time, so an admin editing the cadence mid-checkout takes effect on the very
 * next check-in.
 *
 * No React-Native imports — trivially unit-testable, safe to import from web.
 */

export interface CleanlinessState {
  cleanliness: string;
  jobs_since_clean: number;
}

export interface CheckInResult extends CleanlinessState {
  /**
   * True exactly when THIS check-in is what flipped clean → dirty — callers
   * use this to decide whether to log a single 'unit_auto_dirty' activity
   * entry, never more than once per flip (an already-dirty unit checking in
   * again must not re-log).
   */
  autoDirtied: boolean;
}

/**
 * Apply one job check-in to a unit's cleanliness state.
 *
 * @param current the unit's cleanliness/jobs_since_clean before this check-in
 * @param cleanAfterJobs the OWNING ITEM's cadence — `null` or `<= 0` means
 *   "off" (auto-dirty disabled for this item; the counter still increments,
 *   it's just never consulted)
 */
export function applyCheckIn(current: CleanlinessState, cleanAfterJobs: number | null): CheckInResult {
  const nextCount = current.jobs_since_clean + 1;

  // Auto-dirty only ever fires from a clean state — an already-dirty unit
  // just keeps accumulating its counter (no double-flip, no re-log) until a
  // human (or a future "mark clean") resets it.
  const cadenceOn = cleanAfterJobs != null && cleanAfterJobs > 0;
  const shouldFlip = current.cleanliness === 'clean' && cadenceOn && nextCount >= (cleanAfterJobs as number);

  if (shouldFlip) {
    return { cleanliness: 'dirty', jobs_since_clean: nextCount, autoDirtied: true };
  }
  return { cleanliness: current.cleanliness, jobs_since_clean: nextCount, autoDirtied: false };
}

/** Manual "mark clean" — resets the cadence counter back to zero. */
export function markClean(): CleanlinessState {
  return { cleanliness: 'clean', jobs_since_clean: 0 };
}
