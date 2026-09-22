// Ported from apps/mobile/src/db/queries/equipmentUnits.ts.
//
// Import mapping applied:
//   '../schema'                    → '../db/schema'
//   './items'                      → './items' (partial port — see repos/items.ts)
//   '../../equipment/cleanliness'  → '../equipment/cleanliness' (ported verbatim;
//     repos/ is one level below src/, so the old two-levels-up path becomes one)
//
// Write-path conversion (researched against the old app's actual callers —
// apps/mobile/src/db/queries/equipmentUnits.ts itself never called
// appendOutbox; every UI call site under src/components/quickadd/ hand-rolled
// its OWN appendOutbox('INSERT'|'UPDATE', 'equipment_units', <payload>) next
// to a call to upsertUnit/setUnitStatus, with inconsistent payload shapes
// between call sites — full-row-minus-synced_at in some, changed-fields-only
// in others. That's exactly the drift class createRepository.ts's header
// warns about, and per REBUILD-PORTING.md screens may no longer call
// appendOutbox directly at all. So every mutator below now mirrors to the
// outbox ITSELF via createRepository('equipment_units'), giving future ported
// screens one canonical write path instead of each hand-rolling its own pair:
//   - upsertUnit (whole-row create) → repo.insert(row)  [matches the old
//     EquipmentQuickAdd call site's full-row INSERT]
//   - setUnitStatus / checkInUnitFromJob / markUnitClean / markUnitDirty
//     (all read-modify-write a subset of columns on an existing row) →
//     repo.update(patch) with ONLY the columns actually changing, id included
//     — matches the old QuickAddEditSheet call sites' changes-only payload,
//     now applied uniformly instead of ad hoc per screen.
// NOTE: the pull side (fullDownload) no longer calls a domain-specific
// upsertUnit in v2 — sync/pull.ts applies pulled rows generically from the
// table manifest (packages/core/src/sync/pull.ts), so upsertUnit here is
// purely a UI-facing write helper now; routing it through the outbox-mirroring
// repo is safe (no risk of re-queuing pulled rows).
// NOTE: `synced_at` is intentionally never included in any write payload here
// (same reasoning as maintenance.ts's createMaintenanceEvent) — it's local
// sync bookkeeping, not part of the outbox contract, and createRepository
// does not manage it; the old code's manual `synced_at: null` resets on every
// mutator are dropped as a result (cut — see the port report).
import { getDb, rowsAs, bindParams } from '../db/schema';
import { createRepository } from '@invenpro/core';
import { getItemById } from './items';
import { applyCheckIn, markClean, type CleanlinessState } from '../equipment/cleanliness';

const equipmentUnitsRepo = createRepository('equipment_units');

export interface EquipmentUnit {
  id: string;
  item_id: string;
  asset_tag: string;
  serial_number: string | null;
  status: string;
  current_location_id: string | null;
  current_job_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Lifecycle / depreciation (migration 027). purchase_price & salvage_value are
  // financial — server only pulls them down for view_financial_data holders, so
  // they arrive null on non-financial devices.
  purchase_price: number | null;
  acquired_at: string | null;
  useful_life_months: number | null;
  salvage_value: number | null;
  depreciation_method: string | null;
  next_service_at: string | null;
  service_interval_months: number | null;
  // Cleanliness state (#248, migration 067). cleanliness is free-form TEXT
  // ('clean' | 'dirty' today); jobs_since_clean is the auto-dirty cadence
  // counter — see src/equipment/cleanliness.ts.
  cleanliness: string;
  jobs_since_clean: number;
  synced_at: string | null;
}

export function getUnitsForItem(itemId: string): EquipmentUnit[] {
  const db = getDb();
  return rowsAs<EquipmentUnit>(db.executeSync(
    `SELECT * FROM equipment_units WHERE item_id = ? ORDER BY asset_tag`, [itemId]).rows);
}

export function getAvailableUnitsAtLocation(itemId: string, locationId: string): EquipmentUnit[] {
  const db = getDb();
  return rowsAs<EquipmentUnit>(db.executeSync(
    `SELECT * FROM equipment_units WHERE item_id = ? AND status = 'available' AND current_location_id = ? ORDER BY asset_tag`,
    [itemId, locationId]).rows);
}

// Point lookup by id — used by the Quick Add "edit just-added unit" sheet to seed
// its form fields (getUnitByTag above is for tag-based dup/lookup checks).
export function getUnitById(id: string): EquipmentUnit | null {
  const db = getDb();
  return (db.executeSync(`SELECT * FROM equipment_units WHERE id = ?`, [id]).rows[0] as unknown as EquipmentUnit) ?? null;
}

export function getUnitByTag(tag: string): EquipmentUnit | null {
  const db = getDb();
  // Case-insensitive: a tag differing only in case is the same physical asset,
  // and dup-checks/scan lookups must not let "am-0007" slip past "AM-0007".
  return (db.executeSync(`SELECT * FROM equipment_units WHERE LOWER(asset_tag) = LOWER(?)`, [tag]).rows[0] as unknown as EquipmentUnit) ?? null;
}

// Typeahead over asset tags (and serial numbers) for pickers. Ranks prefix matches
// first, then shorter tags, then alphabetically — so the closest existing units
// surface as you type. Empty query → no results.
export function searchUnitsByTag(q: string, limit = 12): EquipmentUnit[] {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const db = getDb();
  const like = `%${trimmed}%`;
  const prefix = `${trimmed}%`;
  return rowsAs<EquipmentUnit>(db.executeSync(
    `SELECT * FROM equipment_units
       WHERE asset_tag LIKE ? OR serial_number LIKE ?
       ORDER BY (CASE WHEN asset_tag LIKE ? THEN 0 ELSE 1 END), LENGTH(asset_tag), asset_tag
       LIMIT ?`,
    [like, like, prefix, limit],
  ).rows);
}

export function countUnitsByStatus(itemId: string): { available: number; deployed: number; in_repair: number; retired: number } {
  const db = getDb();
  const rows = db.executeSync(`SELECT status, COUNT(*) AS n FROM equipment_units WHERE item_id = ? GROUP BY status`, [itemId]).rows as { status: string; n: number }[];
  const out = { available: 0, deployed: 0, in_repair: 0, retired: 0 } as Record<string, number>;
  for (const r of rows) out[r.status] = r.n;
  return out as { available: number; deployed: number; in_repair: number; retired: number };
}

export function getDeployedUnitsForUser(userId: string): (EquipmentUnit & { item_name: string; job_name: string | null })[] {
  // Units currently deployed, whose most recent checkout_to_job log was by this user.
  const db = getDb();
  return rowsAs<EquipmentUnit & { item_name: string; job_name: string | null }>(db.executeSync(
    `SELECT eu.*, i.name AS item_name, j.name AS job_name
     FROM equipment_units eu
     JOIN inventory_items i ON i.id = eu.item_id
     LEFT JOIN jobs j ON j.id = eu.current_job_id
     WHERE eu.status = 'deployed'
       AND EXISTS (
         SELECT 1 FROM activity_log al
         WHERE al.action = 'checkout_to_job'
           AND al.note = 'unit ' || eu.asset_tag
           AND al.user_id = ?
           AND al.job_id = eu.current_job_id
           AND al.created_at = (
             SELECT MAX(al2.created_at) FROM activity_log al2
             WHERE al2.action = 'checkout_to_job' AND al2.note = 'unit ' || eu.asset_tag
           )
       )
     ORDER BY eu.asset_tag`, [userId]).rows);
}

// Whole-row create (or destructive replace) of a unit — the ONE mutator that
// mirrors a full-row INSERT to the outbox (matches the old EquipmentQuickAdd
// call site). Existing rows should go through setUnitStatus/checkInUnitFromJob/
// markUnitClean/markUnitDirty below instead, which send changed-columns-only
// UPDATE patches.
export function upsertUnit(u: EquipmentUnit): void {
  equipmentUnitsRepo.insert({
    id: u.id, item_id: u.item_id, asset_tag: u.asset_tag, serial_number: u.serial_number,
    status: u.status, current_location_id: u.current_location_id, current_job_id: u.current_job_id,
    notes: u.notes, created_at: u.created_at, updated_at: u.updated_at,
    purchase_price: u.purchase_price ?? null, acquired_at: u.acquired_at ?? null,
    useful_life_months: u.useful_life_months ?? null, salvage_value: u.salvage_value ?? null,
    depreciation_method: u.depreciation_method ?? null, next_service_at: u.next_service_at ?? null,
    service_interval_months: u.service_interval_months ?? null,
    cleanliness: u.cleanliness ?? 'clean', jobs_since_clean: u.jobs_since_clean ?? 0,
  });
}

export function setUnitStatus(
  unitId: string,
  p: { status: string; current_location_id?: string | null; current_job_id?: string | null; notes?: string | null }
): EquipmentUnit {
  const db = getDb();
  const now = new Date().toISOString();
  const cur = db.executeSync(`SELECT * FROM equipment_units WHERE id = ?`, [unitId]).rows[0] as unknown as EquipmentUnit;
  const patch: Record<string, unknown> = { id: unitId, status: p.status, updated_at: now };
  if (p.current_location_id !== undefined) patch.current_location_id = p.current_location_id;
  if (p.current_job_id !== undefined) patch.current_job_id = p.current_job_id;
  if (p.notes !== undefined) patch.notes = p.notes;
  equipmentUnitsRepo.update(patch);
  return {
    ...cur, status: p.status,
    current_location_id: p.current_location_id !== undefined ? p.current_location_id : cur.current_location_id,
    current_job_id: p.current_job_id !== undefined ? p.current_job_id : cur.current_job_id,
    notes: p.notes !== undefined ? p.notes : cur.notes,
    updated_at: now,
  };
}

// #248: the ONLY two real job check-in sites — (checkin)/index.tsx's
// handleUnitCheckin and (hub)/index.tsx's commitReturnBatch — route a unit's
// job check-in through here so the cleanliness cadence is applied exactly
// once per unit, in the same place. Re-reads the OWNING ITEM's
// clean_after_jobs at commit time (not scan/select time) — an admin editing
// the cadence mid-checkout takes effect on this very check-in. Returns the
// fully-updated unit (status/location/job cleared, same as before) plus
// autoDirtied so the caller can conditionally log a single 'unit_auto_dirty'
// activity entry (never more than once per flip).
export function checkInUnitFromJob(
  unitId: string,
  toLocationId: string,
): { unit: EquipmentUnit; autoDirtied: boolean } {
  const db = getDb();
  const cur = db.executeSync(`SELECT * FROM equipment_units WHERE id = ?`, [unitId]).rows[0] as unknown as EquipmentUnit;
  const item = getItemById(cur.item_id);
  const cadence = item?.clean_after_jobs ?? null;
  const cleanlinessIn: CleanlinessState = { cleanliness: cur.cleanliness ?? 'clean', jobs_since_clean: cur.jobs_since_clean ?? 0 };
  const { cleanliness, jobs_since_clean, autoDirtied } = applyCheckIn(cleanlinessIn, cadence);
  const now = new Date().toISOString();
  equipmentUnitsRepo.update({
    id: unitId, status: 'available', current_location_id: toLocationId, current_job_id: null,
    cleanliness, jobs_since_clean, updated_at: now,
  });
  const next: EquipmentUnit = {
    ...cur,
    status: 'available',
    current_location_id: toLocationId,
    current_job_id: null,
    cleanliness,
    jobs_since_clean,
    updated_at: now,
  };
  return { unit: next, autoDirtied };
}

// #248: manual "mark clean" — resets the cadence counter. No confirm (per
// decision); disabled={locked} is the caller's job (useMaintenanceMode gate).
export function markUnitClean(unitId: string): EquipmentUnit {
  const db = getDb();
  const cur = db.executeSync(`SELECT * FROM equipment_units WHERE id = ?`, [unitId]).rows[0] as unknown as EquipmentUnit;
  const { cleanliness, jobs_since_clean } = markClean();
  const updated_at = new Date().toISOString();
  equipmentUnitsRepo.update({ id: unitId, cleanliness, jobs_since_clean, updated_at });
  return { ...cur, cleanliness, jobs_since_clean, updated_at };
}

// #248: manual "mark dirty" — the counter is left untouched (only markUnitClean
// resets it); this just flips the visible state for a unit that got dirty
// off-cadence (e.g. an unusually messy job).
export function markUnitDirty(unitId: string): EquipmentUnit {
  const db = getDb();
  const cur = db.executeSync(`SELECT * FROM equipment_units WHERE id = ?`, [unitId]).rows[0] as unknown as EquipmentUnit;
  const updated_at = new Date().toISOString();
  equipmentUnitsRepo.update({ id: unitId, cleanliness: 'dirty', updated_at });
  return { ...cur, cleanliness: 'dirty', updated_at };
}

// #248: dirty, non-retired units — half of the "Needs cleaning" dashboard
// work-list (the other half is items.ts's getItemsNeedingCleaning). A retired
// unit's grime doesn't need action, so it's excluded.
export function getUnitsNeedingCleaning(): (EquipmentUnit & { item_name: string })[] {
  const db = getDb();
  return rowsAs<EquipmentUnit & { item_name: string }>(db.executeSync(
    `SELECT eu.*, i.name AS item_name
     FROM equipment_units eu
     JOIN inventory_items i ON i.id = eu.item_id
     WHERE eu.cleanliness = 'dirty' AND eu.status != 'retired'
     ORDER BY eu.asset_tag`
  ).rows);
}

// #212 close-out guard: what would be stranded if these jobs were closed right
// now — units still deployed to them, and open (completed_at IS NULL, matching
// getRepairs({done:false})) repairs on those units. One aggregate query pair so
// the jobs screens can gate doClose/saveEdit with a single cheap call.
export function getCloseoutBlockers(jobIds: string[]): { deployedUnits: number; openRepairs: number } {
  if (jobIds.length === 0) return { deployedUnits: 0, openRepairs: 0 };
  const db = getDb();
  const placeholders = jobIds.map(() => '?').join(',');
  const deployedUnits = ((db.executeSync(
    `SELECT COUNT(*) AS cnt FROM equipment_units WHERE current_job_id IN (${placeholders})`,
    [...jobIds]
  ).rows[0] as { cnt: number } | undefined)?.cnt) ?? 0;
  const openRepairs = ((db.executeSync(
    `SELECT COUNT(*) AS cnt FROM repairs r
     JOIN equipment_units eu ON r.entity_type = 'equipment_unit' AND r.entity_id = eu.id
     WHERE eu.current_job_id IN (${placeholders}) AND r.completed_at IS NULL`,
    [...jobIds]
  ).rows[0] as { cnt: number } | undefined)?.cnt) ?? 0;
  return { deployedUnits, openRepairs };
}

// #223: the recovery view of the #212 gap — units still pointing at a job
// that has since been closed (via "close anyway" or a close from another
// device). Deployed-only: retired/in_repair units keep their job pointer as
// history and aren't recoverable field gear.
export function getUnitsStrandedOnClosedJobs(): (EquipmentUnit & { item_name: string; job_name: string; job_number: number | null })[] {
  const db = getDb();
  return rowsAs<EquipmentUnit & { item_name: string; job_name: string; job_number: number | null }>(db.executeSync(
    `SELECT eu.*, i.name AS item_name, j.name AS job_name, j.job_number
     FROM equipment_units eu
     JOIN inventory_items i ON i.id = eu.item_id
     JOIN jobs j ON j.id = eu.current_job_id
     WHERE eu.status = 'deployed' AND j.status = 'closed'
     ORDER BY j.updated_at DESC, eu.asset_tag`
  ).rows);
}

// #212: human copy for the guard's ConfirmSheet — zero buckets are omitted.
export function describeCloseoutBlockers(b: { deployedUnits: number; openRepairs: number }): string {
  const parts: string[] = [];
  if (b.deployedUnits > 0) parts.push(`${b.deployedUnits} unit${b.deployedUnits === 1 ? '' : 's'} still checked out`);
  if (b.openRepairs > 0) parts.push(`${b.openRepairs} open repair${b.openRepairs === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
