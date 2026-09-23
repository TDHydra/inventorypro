import { createRepository, runInTransaction } from '@invenpro/core';
import { getDb, rowsAs, bindParams } from '../db/schema';
import { generateUUID } from '../utils/uuid';
import { ROLE_TIER } from '../constants/roles';
import type { UserRole } from '../constants/roles';
import {
  buildClosePayload,
  buildTakeoverNote,
  canLiftVehicleLock,
  FUEL_UP_TYPE,
  resolveLockStamp,
  resolveVehicleAvailability,
} from '../components/vehicles/vehicleSessionLogic';
import { sharesTeamWithOwner } from './access';

// VEHICLES domain (#125 + #81, migration 042 / API 054). Station C3 (Wave C):
// ported from apps/mobile/src/db/queries/vehicles.ts, adapted to
// createRepository() per docs/REBUILD-PORTING.md's no-self-log convention
// (same conversion schedule.ts applied in Station C2). Three soft-FK tables:
//   vehicles                 1:1 extension of a Vehicle-typed location (PK =
//                            location_id): truck mount, water state, model
//                            (label cache) + model_id (vehicle_model taxonomy
//                            soft-FK), notes. Callers must render defaults
//                            when the row is missing (a Vehicle location can
//                            predate this table).
//   vehicle_service_records  service log; `cost` is financial — the server
//                            omits it for callers without view_financial_data.
//   vehicle_checkouts        individual-holder sessions. Open session =
//                            checked_in_at IS NULL. The server forces
//                            user_id = caller on INSERT and only allows
//                            UPDATE for the own row, manage_teams, or a
//                            CLOSE-ONLY takeover whose payload is exactly
//                            {id, checked_in_at, updated_at}.
//
// Unlike the old app (whose upsertVehicleState/createServiceRecord/
// insertCheckout/checkInVehicle each called appendLog internally), every
// write below returns whatever the caller needs to build its own appendLog
// call(s) inside a runInTransaction it owns — see
// src/components/vehicles/{VehiclePanel,VehicleEditSheet,VehicleCheckoutSheet,
// AddServiceRecordSheet}.tsx call sites.
//
// vehicles' `water_state` column is DEPRECATED (legacy single-tank column,
// kept in the table, never read/written by any UI) and `synced_at` is
// local-only — both must never reach the outbox payload (createRepository's
// insert()/update() forward the payload UNFILTERED to appendOutbox; only the
// local SQL write filters by manifest intersection). upsertVehicleState/
// ensureVehicleRow therefore use vehiclesRepo.mirror() (raw local SQL that
// carries water_state through + a hand-built outbox payload that omits it) —
// the same divergence upsertLocation already uses for type_id/synced_at.
// vehicle_service_records / vehicle_checkouts have no such divergence, so
// their writes go through plain repo.insert()/update().

export const VEHICLE_MODEL_CATEGORY = 'vehicle_model';

export type WaterTank = 'full' | 'empty';
export type WasteTank = 'dirty' | 'clean';
export type ServiceTarget = 'vehicle' | 'truck_mount' | 'both';

export interface VehicleRow {
  location_id: string;
  truck_mount: number; // 0/1
  water_state: string | null; // DEPRECATED: legacy single-tank column — never read/written
  water_tank: WaterTank;
  waste_tank: WasteTank;
  model: string | null;
  model_id: string | null;
  notes: string | null;
  checkout_locked: number; // 0/1 (#157): owner locked the vehicle from checkout
  debris_option: number; // 0/1 (#152): vehicle has the debris tracker
  debris_level: number; // 0-100 (#152)
  open_checkout: number; // 0/1 (#155): owner-assigned vehicle opted into general checkout
  locked_by: string | null; // UUID (#167): who set checkout_locked; NULL = legacy lock
  fuel_level: number; // 0-100 (#174): drag-to-fill fuel gauge, same idiom as debris_level
  updated_at: string;
  synced_at: string | null; // local-only
}

export interface VehicleServiceRecord {
  id: string;
  vehicle_location_id: string;
  target: ServiceTarget;
  event_date: string;
  type: string;
  notes: string | null;
  odometer: number | null;
  cost: number | null;
  payer: string | null; // #168: gas-receipt payer from app_config gas_receipt_payers
  job_id: string | null; // #168: optional job (soft FK)
  created_by: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null; // local-only
}

export interface VehicleCheckout {
  id: string;
  vehicle_location_id: string;
  user_id: string;
  job_id: string | null;
  checked_out_at: string;
  checked_in_at: string | null; // NULL = open session
  created_at: string;
  updated_at: string;
  synced_at: string | null; // local-only
  // Present on history reads (LEFT JOIN users / jobs)
  user_name?: string | null;
  job_name?: string | null;
}

const vehiclesRepo = createRepository('vehicles');
const serviceRecordsRepo = createRepository('vehicle_service_records');
const checkoutsRepo = createRepository('vehicle_checkouts');

// ── vehicles (state extension row) ─────────────────────────────────────────

/** The extension row for a Vehicle-typed location, or null (callers render defaults). */
export function getVehicle(locationId: string): VehicleRow | null {
  const db = getDb();
  const rows = rowsAs<VehicleRow>(db.executeSync(
    `SELECT * FROM vehicles WHERE location_id = ?`, [locationId],
  ).rows);
  return rows[0] ?? null;
}

export interface VehicleStatePatch {
  truck_mount?: number;
  water_tank?: WaterTank;
  waste_tank?: WasteTank;
  model?: string | null;
  model_id?: string | null;
  notes?: string | null;
  checkout_locked?: number; // #157/#165: offered to canManageVehicle holders (edit sheet + panel pill)
  debris_option?: number; // #152
  debris_level?: number; // #152 (0-100; UI clamps)
  open_checkout?: number; // #155: owner opt-in toggle
  fuel_level?: number; // #174 (0-100; UI clamps)
}

/** What the caller needs to build the 'vehicle_state_changed' log entry. */
function describePatch(patch: VehicleStatePatch): string {
  return Object.keys(patch).map(k => `${k}=${String((patch as Record<string, unknown>)[k])}`).join(', ');
}

/**
 * Merge `patch` over the existing row (or defaults when none exists yet) and
 * upsert. Pushed as an outbox INSERT — the server upserts on location_id, so
 * INSERT converges whether or not the row exists remotely. Returns the note
 * text the caller should log against `vehicle_state_changed` (entity_type
 * 'location', entity_id locationId) — this function does NOT self-log.
 */
export function upsertVehicleState(
  locationId: string,
  patch: VehicleStatePatch,
  userId: string | null,
): string {
  const now = new Date().toISOString();
  const note = describePatch(patch);
  runInTransaction(() => {
    const existing = getVehicle(locationId);
    const merged: VehicleRow = {
      location_id: locationId,
      truck_mount: patch.truck_mount ?? existing?.truck_mount ?? 0,
      water_state: existing?.water_state ?? null, // carried through, never patched
      water_tank: patch.water_tank ?? existing?.water_tank ?? 'empty',
      waste_tank: patch.waste_tank ?? existing?.waste_tank ?? 'clean',
      model: patch.model !== undefined ? patch.model : existing?.model ?? null,
      model_id: patch.model_id !== undefined ? patch.model_id : existing?.model_id ?? null,
      notes: patch.notes !== undefined ? patch.notes : existing?.notes ?? null,
      checkout_locked: patch.checkout_locked ?? existing?.checkout_locked ?? 0,
      debris_option: patch.debris_option ?? existing?.debris_option ?? 0,
      debris_level: patch.debris_level ?? existing?.debris_level ?? 0,
      open_checkout: patch.open_checkout ?? existing?.open_checkout ?? 0,
      locked_by: resolveLockStamp(patch, existing, userId),
      fuel_level: patch.fuel_level ?? existing?.fuel_level ?? 0,
      updated_at: now,
      synced_at: null,
    };
    const { synced_at: _s, water_state: _w, ...outboxRow } = merged;
    vehiclesRepo.mirror('INSERT', outboxRow, () => {
      getDb().executeSync(
        `INSERT OR REPLACE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, synced_at, water_tank, waste_tank, checkout_locked, debris_option, debris_level, open_checkout, locked_by, fuel_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bindParams([merged.location_id, merged.truck_mount, merged.water_state, merged.model, merged.model_id, merged.notes, merged.updated_at, merged.water_tank, merged.waste_tank, merged.checkout_locked, merged.debris_option, merged.debris_level, merged.open_checkout, merged.locked_by, merged.fuel_level]),
      );
    });
  });
  return note;
}

/**
 * Make sure a Vehicle-typed location has its vehicles extension row — called
 * by every vehicle-location creation path (VehicleQuickAdd, findOrCreate
 * VehicleByName, the generic location create form). Idempotent; no activity
 * log (the caller already logs location_created — same as the old app).
 * Joins the caller's transaction when nested.
 */
export function ensureVehicleRow(
  locationId: string,
  init?: { model?: string | null; model_id?: string | null; truck_mount?: 0 | 1; debris_option?: 0 | 1 },
): void {
  runInTransaction(() => {
    if (getVehicle(locationId)) return;
    const now = new Date().toISOString();
    const truckMount = init?.truck_mount ?? 0;
    const debrisOption = init?.debris_option ?? 0;
    vehiclesRepo.mirror('INSERT', {
      location_id: locationId, truck_mount: truckMount,
      model: init?.model ?? null, model_id: init?.model_id ?? null,
      notes: null, updated_at: now, water_tank: 'empty', waste_tank: 'clean',
      checkout_locked: 0, debris_option: debrisOption,
    }, () => {
      getDb().executeSync(
        `INSERT OR IGNORE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, synced_at, water_tank, waste_tank, checkout_locked, debris_option)
         VALUES (?, ?, NULL, ?, ?, NULL, ?, NULL, 'empty', 'clean', 0, ?)`,
        bindParams([locationId, truckMount, init?.model ?? null, init?.model_id ?? null, now, debrisOption]),
      );
    });
  });
}

// ── vehicle_service_records ────────────────────────────────────────────────

/** Service records for a vehicle, newest first. */
export function getServiceRecords(locationId: string, limit?: number): VehicleServiceRecord[] {
  const db = getDb();
  const sql = `SELECT * FROM vehicle_service_records WHERE vehicle_location_id = ?
               ORDER BY event_date DESC, created_at DESC${limit != null ? ' LIMIT ?' : ''}`;
  const params = limit != null ? [locationId, limit] : [locationId];
  return rowsAs<VehicleServiceRecord>(db.executeSync(sql, params).rows);
}

export interface ServiceRecordWriteResult {
  id: string;
  /** Note text the caller should log against 'vehicle_service_logged'. */
  note: string;
}

/** Insert a service record + outbox INSERT. Does NOT self-log — see header. */
export function createServiceRecord(input: {
  vehicleLocationId: string;
  target: ServiceTarget;
  eventDate: string;
  type: string;
  notes?: string | null;
  odometer?: number | null;
  cost?: number | null;
  payer?: string | null; // #168: gas-receipt payer (app_config gas_receipt_payers)
  jobId?: string | null; // #168: optional job (soft FK)
  logNote?: string | null; // #168: overrides the activity-log note (vehicle-mismatch receipts)
  userId: string | null;
}): ServiceRecordWriteResult {
  const id = generateUUID();
  const now = new Date().toISOString();
  serviceRecordsRepo.insert({
    id,
    vehicle_location_id: input.vehicleLocationId,
    target: input.target,
    event_date: input.eventDate,
    type: input.type,
    notes: input.notes ?? null,
    odometer: input.odometer ?? null,
    cost: input.cost ?? null,
    payer: input.payer ?? null,
    job_id: input.jobId ?? null,
    created_by: input.userId,
    created_at: now,
    updated_at: now,
  });
  return { id, note: input.logNote ?? input.type };
}

// ── vehicle_checkouts ──────────────────────────────────────────────────────

/** The open session for a vehicle (checked_in_at IS NULL), or null. */
export function getActiveCheckout(locationId: string): VehicleCheckout | null {
  const db = getDb();
  const rows = rowsAs<VehicleCheckout>(db.executeSync(
    `SELECT c.*, u.name AS user_name, j.name AS job_name
       FROM vehicle_checkouts c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN jobs j ON j.id = c.job_id
      WHERE c.vehicle_location_id = ? AND c.checked_in_at IS NULL
      ORDER BY c.checked_out_at DESC LIMIT 1`,
    [locationId],
  ).rows);
  return rows[0] ?? null;
}

/**
 * The current user's open vehicle session (if any), with the vehicle's name
 * joined in — feeds the dashboard check-in quick-action.
 */
export function getActiveCheckoutForUser(
  userId: string,
): (VehicleCheckout & { vehicle_name: string }) | null {
  const db = getDb();
  const rows = rowsAs<VehicleCheckout & { vehicle_name: string }>(db.executeSync(
    `SELECT c.*, l.name AS vehicle_name
       FROM vehicle_checkouts c
       JOIN locations l ON l.id = c.vehicle_location_id
      WHERE c.user_id = ? AND c.checked_in_at IS NULL
      ORDER BY c.checked_out_at DESC LIMIT 1`,
    [userId],
  ).rows);
  return rows[0] ?? null;
}

/** Recent sessions (open first, then newest), with holder/job names joined in. */
export function getCheckoutHistory(locationId: string, limit = 5): VehicleCheckout[] {
  const db = getDb();
  return rowsAs<VehicleCheckout>(db.executeSync(
    `SELECT c.*, u.name AS user_name, j.name AS job_name
       FROM vehicle_checkouts c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN jobs j ON j.id = c.job_id
      WHERE c.vehicle_location_id = ?
      ORDER BY c.checked_out_at DESC LIMIT ?`,
    [locationId, limit],
  ).rows);
}

/** What a caller needs to build the 'vehicle_checkout' log entry. */
export interface CheckoutWriteResult {
  id: string;
  jobId: string | null;
  note: string;
}

// Shared INSERT body for checkOutVehicle / takeOverVehicle — must run inside a
// transaction. The server forces user_id = caller on INSERT, so each device
// pushes its own row (attribution). No self-log — see header.
function insertCheckout(locationId: string, jobId: string | null, userId: string, note: string): CheckoutWriteResult {
  const id = generateUUID();
  const now = new Date().toISOString();
  checkoutsRepo.insert({
    id, vehicle_location_id: locationId, user_id: userId, job_id: jobId,
    checked_out_at: now, checked_in_at: null, created_at: now, updated_at: now,
  });
  return { id, jobId, note };
}

/**
 * Lock guard for every session-opening path (checkOutVehicle / takeOverVehicle).
 * #157 introduced the lock; #167 made BYPASS FOLLOW UNLOCK: when locked, only a
 * caller who could lift the lock passes — canManageVehicle AND (legacy NULL
 * locker OR self-lock OR own tier >= locker's CURRENT tier). A crew owner whose
 * vehicle was locked by a PM is blocked from checkout too. The manage predicate
 * below duplicates canManageVehicle (repos/access.ts) — kept in sync manually:
 * this path resolves from a bare userId, not a UserSession.
 */
export function isCheckoutLockedFor(locationId: string, userId: string | null): boolean {
  const db = getDb();
  const row = rowsAs<{
    checkout_locked: number; locked_by: string | null; owner_user_id: string | null;
    role: string | null; locker_role: string | null;
  }>(
    db.executeSync(
      `SELECT v.checkout_locked, v.locked_by, l.owner_user_id,
              (SELECT role FROM users WHERE id = ?) AS role,
              (SELECT role FROM users WHERE id = v.locked_by) AS locker_role
         FROM vehicles v JOIN locations l ON l.id = v.location_id
        WHERE v.location_id = ?`,
      [userId, locationId],
    ).rows,
  )[0];
  if (!row || !row.checkout_locked) return false;
  const tier = ROLE_TIER[row.role as UserRole] ?? 0;
  const manages =
    (userId != null && row.owner_user_id === userId)
    || tier >= 3
    || (tier >= 2 && userId != null && sharesTeamWithOwner(userId, row.owner_user_id));
  if (!manages) return true;
  return !canLiftVehicleLock({
    canManage: true,
    lockedBy: row.locked_by,
    lockerTier: ROLE_TIER[row.locker_role as UserRole] ?? 0,
    userId,
    userTier: tier,
  });
}

/**
 * #155: is this vehicle in the caller's checkable set RIGHT NOW? Free of an
 * open session AND (unowned OR opted in OR theirs) AND not locked against them
 * (#167 tier rule via isCheckoutLockedFor). Backs the list's Available segment;
 * the panel button derives the same answer from its own loaded rows.
 */
export function isVehicleAvailableForCheckout(locationId: string, userId: string | null): boolean {
  const db = getDb();
  const row = rowsAs<{ owner_user_id: string | null; open_checkout: number | null; has_open: number }>(
    db.executeSync(
      `SELECT l.owner_user_id, v.open_checkout,
              EXISTS(SELECT 1 FROM vehicle_checkouts c
                      WHERE c.vehicle_location_id = l.id AND c.checked_in_at IS NULL) AS has_open
         FROM locations l LEFT JOIN vehicles v ON v.location_id = l.id
        WHERE l.id = ?`,
      [locationId],
    ).rows,
  )[0];
  if (!row) return false;
  const a = resolveVehicleAvailability({
    ownerUserId: row.owner_user_id,
    openCheckout: row.open_checkout ?? 0,
    hasOpenSession: !!row.has_open,
    userId,
  });
  return a.available && !isCheckoutLockedFor(locationId, userId);
}

/** Throws when the owner lock blocks `userId` — shared by check-out and take-over. */
function assertCheckoutAllowed(locationId: string, userId: string): void {
  if (isCheckoutLockedFor(locationId, userId)) {
    throw new Error('This vehicle is locked from checkout.');
  }
}

/** Open a new session (no open-session check here — callers resolve takeover first). */
export function checkOutVehicle(locationId: string, jobId: string | null, userId: string): CheckoutWriteResult {
  assertCheckoutAllowed(locationId, userId);
  return runInTransaction(() => insertCheckout(locationId, jobId, userId, 'checked out'));
}

/** What a caller needs to build the 'vehicle_checkin' log entry. */
export interface CheckinResult {
  session: VehicleCheckout;
}

/**
 * Close a session. The outbox payload is the close-only shape
 * {id, checked_in_at, updated_at} — valid for the own row AND for the server's
 * takeover guard, so this same helper backs both check-in and takeover-close.
 * Returns null (no-op) when the session is already closed / unknown. No
 * self-log — the caller builds 'vehicle_checkin' from the returned session
 * (vehicle_location_id, job_id).
 */
export function checkInVehicle(sessionId: string): CheckinResult | null {
  let result: CheckinResult | null = null;
  runInTransaction(() => {
    const db = getDb();
    const session = rowsAs<VehicleCheckout>(db.executeSync(
      `SELECT * FROM vehicle_checkouts WHERE id = ?`, [sessionId],
    ).rows)[0];
    if (!session || session.checked_in_at != null) return; // already closed / unknown
    const payload = buildClosePayload(sessionId, new Date().toISOString());
    checkoutsRepo.update(payload);
    result = { session };
  });
  return result;
}

/** Attach (or change) the job on a session — an own-row UPDATE. No log (matches old app: never logged). */
export function addJobToActiveCheckout(sessionId: string, jobId: string | null): void {
  checkoutsRepo.update({ id: sessionId, job_id: jobId });
}

/** What a caller needs to build the 'vehicle_checkout' (took-over) log, plus any prior holder's session for context. */
export interface TakeoverResult extends CheckoutWriteResult {
  /** The prior holder's session, now closed (null when there was no open session to close). */
  closedSession: VehicleCheckout | null;
}

/**
 * Warn-and-take-over: close the holder's open session (close-only UPDATE — the
 * ONLY shape the server's takeover guard accepts from a non-holder), then open
 * a fresh session for the caller. One transaction; the outbox preserves order,
 * so the close pushes before the INSERT.
 */
export function takeOverVehicle(locationId: string, jobId: string | null, userId: string): TakeoverResult {
  assertCheckoutAllowed(locationId, userId); // #157: takeover must not bypass the owner lock
  return runInTransaction(() => {
    const open = getActiveCheckout(locationId);
    // #141: the activity note preserves who held the vehicle and since when —
    // the closed session row survives, but the log is where people look.
    let note = 'took over';
    let closedSession: VehicleCheckout | null = null;
    if (open && open.checked_in_at == null) {
      const nowIso = new Date().toISOString();
      note = buildTakeoverNote(open.user_name ?? null, open.checked_out_at, nowIso);
      const payload = buildClosePayload(open.id, nowIso);
      checkoutsRepo.update(payload);
      closedSession = open;
    }
    const opened = insertCheckout(locationId, jobId, userId, note);
    return { ...opened, closedSession };
  });
}

// ── history-panel reads (#141) ─────────────────────────────────────────────

export interface OdometerReading {
  id: string;
  event_date: string;
  odometer: number;
  type: string;
}

/** Service records that carry an odometer reading, newest first. */
export function getOdometerTimeline(locationId: string, limit = 20): OdometerReading[] {
  const db = getDb();
  return rowsAs<OdometerReading>(db.executeSync(
    `SELECT id, event_date, odometer, type FROM vehicle_service_records
      WHERE vehicle_location_id = ? AND odometer IS NOT NULL
      ORDER BY event_date DESC, created_at DESC LIMIT ?`,
    [locationId, limit],
  ).rows);
}

/** Fuel-up records (type = 'fuel_up'), newest first. */
export function getFuelUps(locationId: string, limit = 10): VehicleServiceRecord[] {
  const db = getDb();
  return rowsAs<VehicleServiceRecord>(db.executeSync(
    `SELECT * FROM vehicle_service_records
      WHERE vehicle_location_id = ? AND type = ?
      ORDER BY event_date DESC, created_at DESC LIMIT ?`,
    [locationId, FUEL_UP_TYPE, limit],
  ).rows);
}

// ── list-row status (VehicleInlineStatus) ──────────────────────────────────

export interface VehicleInlineStatusRow {
  water_tank: WaterTank | null;
  waste_tank: WasteTank | null;
  truck_mount: number | null;
  holder_name: string | null; // open session holder, or null
}

/** One-statement status read for list rows — cheap enough to run per row. */
export function getVehicleInlineStatus(locationId: string): VehicleInlineStatusRow {
  const db = getDb();
  const rows = rowsAs<VehicleInlineStatusRow>(db.executeSync(
    `SELECT
       (SELECT water_tank FROM vehicles WHERE location_id = ?) AS water_tank,
       (SELECT waste_tank FROM vehicles WHERE location_id = ?) AS waste_tank,
       (SELECT truck_mount FROM vehicles WHERE location_id = ?) AS truck_mount,
       (SELECT COALESCE(u.name, c.user_id) FROM vehicle_checkouts c
          LEFT JOIN users u ON u.id = c.user_id
         WHERE c.vehicle_location_id = ? AND c.checked_in_at IS NULL
         ORDER BY c.checked_out_at DESC LIMIT 1) AS holder_name`,
    [locationId, locationId, locationId, locationId],
  ).rows);
  return rows[0] ?? { water_tank: null, waste_tank: null, truck_mount: null, holder_name: null };
}
