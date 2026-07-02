import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';
import { runInTransaction } from '../tx';
import { generateUUID } from '../../utils/uuid';

// A maintenance_events row: a service/repair/inspection event logged against a
// single equipment unit (migration 027 / API 033). No FK on unit_id — matches
// repair_parts' sync-order-safe design (rows can pull/push out of order). `cost`
// is financial and only pulls down to view_financial_data holders (null else).
export interface MaintenanceEvent {
  id: string;
  unit_id: string;
  event_date: string;
  type: string;
  notes: string | null;
  cost: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null; // local-only
}

// Insert a maintenance event locally + queue the outbox INSERT (synced_at stripped
// — the server table has no such column) + write an activity_log entry. Atomic:
// the local row, its outbox entry, and the log all commit together. Returns the
// new event id.
export function createMaintenanceEvent(input: {
  unitId: string;
  eventDate: string;
  type: string;
  notes?: string | null;
  cost?: number | null;
  userId: string | null;
}): string {
  const id = generateUUID();
  const now = new Date().toISOString();
  const notes = input.notes ?? null;
  const cost = input.cost ?? null;

  runInTransaction(() => {
    const db = getDb();
    db.executeSync(
      `INSERT INTO maintenance_events (id, unit_id, event_date, type, notes, cost, created_by, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      bindParams([id, input.unitId, input.eventDate, input.type, notes, cost, input.userId, now, now]),
    );
    appendOutbox('INSERT', 'maintenance_events', {
      id, unit_id: input.unitId, event_date: input.eventDate, type: input.type,
      notes, cost, created_by: input.userId, created_at: now, updated_at: now,
    });
    appendLog({
      action: 'maintenance_event',
      entity_type: 'equipment_unit',
      entity_id: input.unitId,
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

// Events for a unit, newest first.
export function getMaintenanceEventsForUnit(unitId: string): MaintenanceEvent[] {
  const db = getDb();
  return rowsAs<MaintenanceEvent>(db.executeSync(
    `SELECT * FROM maintenance_events WHERE unit_id = ? ORDER BY event_date DESC, created_at DESC`,
    [unitId],
  ).rows);
}

// Units with a scheduled next service that is now due (next_service_at <= now).
export function getUnitsDueForService(nowIso: string): { id: string; asset_tag: string; next_service_at: string }[] {
  const db = getDb();
  return db.executeSync(
    `SELECT id, asset_tag, next_service_at FROM equipment_units
       WHERE next_service_at IS NOT NULL AND next_service_at <= ?
       ORDER BY next_service_at ASC`,
    [nowIso],
  ).rows as { id: string; asset_tag: string; next_service_at: string }[];
}
