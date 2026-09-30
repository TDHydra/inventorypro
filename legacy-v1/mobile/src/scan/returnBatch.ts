// Pure logic for the hub Fast Check-In "returns" batch (#151) — no react/db
// imports so invariants run under plain `node --test`; precedent:
// vehicleSessionLogic.ts. The hub screen owns the DB side-effects (setUnitStatus
// / outboxUnit / appendLog); this module is only the validation + log-row shape.

export interface ReturnDestination {
  type: 'location' | 'job' | 'manager' | 'office';
  toLocationId: string | null;
}

/**
 * v1 policy: a return batch may only land at a Location destination — job,
 * manager, and office resolutions are rejected (office IS a location under the
 * hood, but the wave doc calls it out separately from "location", so it's kept
 * explicit here rather than accidentally passing via toLocationId != null).
 */
export function validateReturnDestination(
  dest: ReturnDestination,
): { ok: true } | { ok: false; reason: string } {
  if (dest.type !== 'location' || !dest.toLocationId) {
    return {
      ok: false,
      reason: 'Returns can only go to a location — pick a shelf, vehicle, or locker destination.',
    };
  }
  return { ok: true };
}

export interface ReturnUnit {
  id: string;
  item_id: string;
  asset_tag: string;
  current_job_id: string | null;
}

export interface ReturnLogRow {
  action: 'checkin';
  entity_id: string;
  from_location_id: null;
  to_location_id: string;
  job_id: string | null;
  quantity: 1;
  note: string;
  id?: string;
}

/**
 * Per-unit activity_log rows for a committed return batch. The shape is a hard
 * contract — getDeployedUnitsForUser's note-based inference
 * (equipmentUnits.ts:80-101) depends on `note === 'unit ' + asset_tag`; job_id
 * is the unit's CAPTURED current_job_id (read before the status flip to
 * 'available' clears it). A stable event UUID rides the FIRST row only, same
 * idiom as (checkin)/index.tsx's primary-log convention.
 */
export function buildReturnLogRows(
  units: readonly ReturnUnit[],
  toLocationId: string,
  eventId: string,
): ReturnLogRow[] {
  return units.map((u, i) => ({
    action: 'checkin' as const,
    entity_id: u.item_id,
    from_location_id: null,
    to_location_id: toLocationId,
    job_id: u.current_job_id,
    quantity: 1 as const,
    note: 'unit ' + u.asset_tag,
    ...(i === 0 ? { id: eventId } : {}),
  }));
}
