import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';
import { runInTransaction } from '../tx';
import { generateUUID } from '../../utils/uuid';
import { buildClosePayload } from '../../components/vehicles/vehicleSessionLogic';

// VEHICLES domain (#125 + #81, migration 042 / API 054). Three soft-FK tables:
//   vehicles                 1:1 extension of a Vehicle-typed location (PK =
//                            location_id): truck mount, water state, model
//                            (label cache) + model_id (vehicle_model taxonomy
//                            soft-FK — the server auto-resolves the label from
//                            the id), notes. Callers must render defaults when
//                            the row is missing (a Vehicle location can predate
//                            this table or be created by an older client).
//   vehicle_service_records  service log; `cost` is financial — the server
//                            omits it for callers without view_financial_data
//                            (maintenance_events pattern), so it's nullable.
//   vehicle_checkouts        individual-holder sessions. Open session =
//                            checked_in_at IS NULL. The server forces
//                            user_id = caller on INSERT (attribution) and only
//                            allows UPDATE for the own row, manage_teams, or a
//                            CLOSE-ONLY takeover whose payload is exactly
//                            {id, checked_in_at, updated_at} — takeover =
//                            close the stale session, then INSERT a fresh one.
// Write pattern follows createMaintenanceEvent: runInTransaction(local write +
// appendOutbox + appendLog), synced_at stripped from outbox payloads.

export const VEHICLE_MODEL_CATEGORY = 'vehicle_model';

export type WaterTank = 'full' | 'empty';
export type WasteTank = 'dirty' | 'clean';
export type ServiceTarget = 'vehicle' | 'truck_mount' | 'both';

export interface VehicleRow {
  location_id: string;
  truck_mount: number; // 0/1
  water_state: string | null; // DEPRECATED (#122 A2): legacy single-tank column — kept in the table, never read/written
  water_tank: WaterTank;
  waste_tank: WasteTank;
  model: string | null;
  model_id: string | null;
  notes: string | null;
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
}

/**
 * Merge `patch` over the existing row (or defaults when none exists yet) and
 * upsert. Pushed as an outbox INSERT — the server upserts on location_id, so
 * INSERT converges whether or not the row exists remotely. Logs
 * vehicle_state_changed against the location.
 */
export function upsertVehicleState(
  locationId: string,
  patch: VehicleStatePatch,
  userId: string | null,
): void {
  const now = new Date().toISOString();
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
      updated_at: now,
      synced_at: null,
    };
    const db = getDb();
    db.executeSync(
      `INSERT OR REPLACE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, synced_at, water_tank, waste_tank)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      bindParams([merged.location_id, merged.truck_mount, merged.water_state, merged.model, merged.model_id, merged.notes, merged.updated_at, merged.water_tank, merged.waste_tank]),
    );
    const { synced_at: _s, water_state: _w, ...row } = merged;
    appendOutbox('INSERT', 'vehicles', row);
    appendLog({
      action: 'vehicle_state_changed',
      entity_type: 'location',
      entity_id: locationId,
      user_id: userId,
      team_id: null,
      job_id: null,
      note: Object.keys(patch).map(k => `${k}=${String((patch as Record<string, unknown>)[k])}`).join(', '),
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      metadata: null,
      device_id: null,
    });
  });
}

/**
 * Make sure a Vehicle-typed location has its vehicles extension row — called by
 * EVERY vehicle-location creation path (VehicleQuickAdd, findOrCreateVehicleByName,
 * the generic location create form). Idempotent; no activity log (the caller
 * already logs location_created). Joins the caller's transaction when nested.
 */
export function ensureVehicleRow(
  locationId: string,
  init?: { model?: string | null; model_id?: string | null; truck_mount?: 0 | 1 },
): void {
  runInTransaction(() => {
    if (getVehicle(locationId)) return;
    const now = new Date().toISOString();
    const truckMount = init?.truck_mount ?? 0;
    const db = getDb();
    db.executeSync(
      `INSERT OR IGNORE INTO vehicles (location_id, truck_mount, water_state, model, model_id, notes, updated_at, synced_at, water_tank, waste_tank)
       VALUES (?, ?, NULL, ?, ?, NULL, ?, NULL, 'empty', 'clean')`,
      bindParams([locationId, truckMount, init?.model ?? null, init?.model_id ?? null, now]),
    );
    appendOutbox('INSERT', 'vehicles', {
      location_id: locationId, truck_mount: truckMount,
      model: init?.model ?? null, model_id: init?.model_id ?? null,
      notes: null, updated_at: now, water_tank: 'empty', waste_tank: 'clean',
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

/** Insert a service record + outbox INSERT + vehicle_service_logged log. Returns the new id. */
export function createServiceRecord(input: {
  vehicleLocationId: string;
  target: ServiceTarget;
  eventDate: string;
  type: string;
  notes?: string | null;
  odometer?: number | null;
  cost?: number | null;
  userId: string | null;
}): string {
  const id = generateUUID();
  const now = new Date().toISOString();
  const notes = input.notes ?? null;
  const odometer = input.odometer ?? null;
  const cost = input.cost ?? null;

  runInTransaction(() => {
    const db = getDb();
    db.executeSync(
      `INSERT INTO vehicle_service_records (id, vehicle_location_id, target, event_date, type, notes, odometer, cost, created_by, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      bindParams([id, input.vehicleLocationId, input.target, input.eventDate, input.type, notes, odometer, cost, input.userId, now, now]),
    );
    appendOutbox('INSERT', 'vehicle_service_records', {
      id, vehicle_location_id: input.vehicleLocationId, target: input.target,
      event_date: input.eventDate, type: input.type, notes, odometer, cost,
      created_by: input.userId, created_at: now, updated_at: now,
    });
    appendLog({
      action: 'vehicle_service_logged',
      entity_type: 'location',
      entity_id: input.vehicleLocationId,
      user_id: input.userId,
      team_id: null,
      job_id: null,
      note: input.type,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      metadata: null,
      device_id: null,
    });
  });

  return id;
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

// Shared INSERT body for checkOutVehicle / takeOverVehicle — must run inside a
// transaction. The server forces user_id = caller on INSERT, so each device
// pushes its own row (attribution).
function insertCheckout(locationId: string, jobId: string | null, userId: string, note: string): string {
  const id = generateUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.executeSync(
    `INSERT INTO vehicle_checkouts (id, vehicle_location_id, user_id, job_id, checked_out_at, checked_in_at, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    bindParams([id, locationId, userId, jobId, now, now, now]),
  );
  appendOutbox('INSERT', 'vehicle_checkouts', {
    id, vehicle_location_id: locationId, user_id: userId, job_id: jobId,
    checked_out_at: now, checked_in_at: null, created_at: now, updated_at: now,
  });
  appendLog({
    action: 'vehicle_checkout',
    entity_type: 'location',
    entity_id: locationId,
    user_id: userId,
    team_id: null,
    job_id: jobId,
    note,
    from_location_id: null,
    to_location_id: null,
    quantity: null,
    unit: null,
    metadata: null,
    device_id: null,
  });
  return id;
}

/** Open a new session (no open-session check here — callers resolve takeover first). */
export function checkOutVehicle(locationId: string, jobId: string | null, userId: string): string {
  return runInTransaction(() => insertCheckout(locationId, jobId, userId, 'checked out'));
}

/**
 * Close a session. The outbox payload is the close-only shape
 * {id, checked_in_at, updated_at} — valid for the own row AND for the server's
 * takeover guard, so this same helper backs both check-in and takeover-close.
 */
export function checkInVehicle(sessionId: string, userId: string | null): void {
  runInTransaction(() => {
    const db = getDb();
    const session = rowsAs<VehicleCheckout>(db.executeSync(
      `SELECT * FROM vehicle_checkouts WHERE id = ?`, [sessionId],
    ).rows)[0];
    if (!session || session.checked_in_at != null) return; // already closed / unknown
    const payload = buildClosePayload(sessionId, new Date().toISOString());
    db.executeSync(
      `UPDATE vehicle_checkouts SET checked_in_at = ?, updated_at = ?, synced_at = NULL WHERE id = ?`,
      bindParams([payload.checked_in_at, payload.updated_at, sessionId]),
    );
    appendOutbox('UPDATE', 'vehicle_checkouts', payload);
    appendLog({
      action: 'vehicle_checkin',
      entity_type: 'location',
      entity_id: session.vehicle_location_id,
      user_id: userId,
      team_id: null,
      job_id: session.job_id,
      note: 'checked in',
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      metadata: null,
      device_id: null,
    });
  });
}

/** Attach (or change) the job on a session — an own-row UPDATE. */
export function addJobToActiveCheckout(sessionId: string, jobId: string | null): void {
  const now = new Date().toISOString();
  runInTransaction(() => {
    const db = getDb();
    db.executeSync(
      `UPDATE vehicle_checkouts SET job_id = ?, updated_at = ?, synced_at = NULL WHERE id = ?`,
      bindParams([jobId, now, sessionId]),
    );
    appendOutbox('UPDATE', 'vehicle_checkouts', { id: sessionId, job_id: jobId, updated_at: now });
  });
}

/**
 * Warn-and-take-over: close the holder's open session (close-only UPDATE — the
 * ONLY shape the server's takeover guard accepts from a non-holder), then open
 * a fresh session for the caller. One transaction; the outbox preserves order,
 * so the close pushes before the INSERT.
 */
export function takeOverVehicle(locationId: string, jobId: string | null, userId: string): string {
  return runInTransaction(() => {
    const open = getActiveCheckout(locationId);
    if (open && open.checked_in_at == null) {
      const payload = buildClosePayload(open.id, new Date().toISOString());
      const db = getDb();
      db.executeSync(
        `UPDATE vehicle_checkouts SET checked_in_at = ?, updated_at = ?, synced_at = NULL WHERE id = ?`,
        bindParams([payload.checked_in_at, payload.updated_at, open.id]),
      );
      appendOutbox('UPDATE', 'vehicle_checkouts', payload);
    }
    return insertCheckout(locationId, jobId, userId, 'took over');
  });
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
