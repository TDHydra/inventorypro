import { getDb, rowsAs, bindParams } from '../schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from './log';
import { runInTransaction } from '../tx';

// Per-action unit access (#122 Phase A1) — successor to access.ts's binary
// locker_access grants. Server enforcement: owner-or-org-authority per-row
// guard in routes/sync.ts (shared with locker_access) + granted_by attribution.

export interface UnitAccessRow {
  location_id: string; user_id: string;
  can_view: number; can_add: number; can_remove: number; can_move: number;
  can_edit_details: number; can_grant: number;
  granted_by: string | null; created_at: string; updated_at: string;
  synced_at: string | null; // local-only
  user_name?: string | null; // present on getUnitAccessRows reads
}

export interface UnitPerms {
  view: boolean; add: boolean; remove: boolean; move: boolean;
  editDetails: boolean; grant: boolean;
}

/** Every grant on a unit, with user names, name order (access-panel listing). */
export function getUnitAccessRows(locationId: string): UnitAccessRow[] {
  const db = getDb();
  return rowsAs<UnitAccessRow>(db.executeSync(
    `SELECT ua.*, u.name AS user_name
       FROM unit_access ua LEFT JOIN users u ON u.id = ua.user_id
      WHERE ua.location_id = ?
      ORDER BY u.name NULLS LAST, ua.user_id`,
    [locationId],
  ).rows);
}

/** One user's per-action perms on one unit. No row → all false (fail closed). */
export function getUserUnitPerms(userId: string, locationId: string): UnitPerms {
  const db = getDb();
  const r = rowsAs<UnitAccessRow>(db.executeSync(
    `SELECT * FROM unit_access WHERE location_id = ? AND user_id = ?`,
    [locationId, userId],
  ).rows)[0];
  return {
    view: !!r?.can_view, add: !!r?.can_add, remove: !!r?.can_remove,
    move: !!r?.can_move, editDetails: !!r?.can_edit_details, grant: !!r?.can_grant,
  };
}

/** Grant flags accept booleans or raw 0/1 (later phases spread stored rows in). */
export type AccessFlag = boolean | 0 | 1;

export interface UnitAccessUpsert {
  location_id: string; user_id: string;
  can_view: AccessFlag; can_add: AccessFlag; can_remove: AccessFlag; can_move: AccessFlag;
  can_edit_details: AccessFlag; can_grant: AccessFlag;
  granted_by: string | null;
  /** Optional — defaulted to now when absent; grant EDITS may carry the original created_at. */
  created_at?: string; updated_at?: string;
}

/**
 * Create or edit a grant. Local upsert (composite PK) + outbox INSERT (the
 * server upserts on location_id,user_id and re-forces granted_by to the caller)
 * + activity log, atomic. Flags accept boolean or 0/1 and are stored 0/1;
 * created_at/updated_at default to now when the caller doesn't supply them.
 */
export function upsertUnitAccess(row: UnitAccessUpsert): void {
  const now = new Date().toISOString();
  const created = row.created_at ?? now;
  const updated = row.updated_at ?? now;
  const b = (v: AccessFlag) => (v ? 1 : 0);
  runInTransaction(() => {
    const db = getDb();
    db.executeSync(
      `INSERT OR REPLACE INTO unit_access
         (location_id, user_id, can_view, can_add, can_remove, can_move, can_edit_details, can_grant, granted_by, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      bindParams([row.location_id, row.user_id, b(row.can_view), b(row.can_add), b(row.can_remove), b(row.can_move), b(row.can_edit_details), b(row.can_grant), row.granted_by, created, updated]),
    );
    appendOutbox('INSERT', 'unit_access', {
      location_id: row.location_id, user_id: row.user_id,
      can_view: b(row.can_view), can_add: b(row.can_add), can_remove: b(row.can_remove),
      can_move: b(row.can_move), can_edit_details: b(row.can_edit_details), can_grant: b(row.can_grant),
      granted_by: row.granted_by, created_at: created, updated_at: updated,
    });
    appendLog({
      action: 'locker_access_granted', entity_type: 'location', entity_id: row.location_id,
      user_id: row.granted_by, team_id: null, job_id: null,
      note: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
      metadata: JSON.stringify({ grantee_user_id: row.user_id, actions: { view: !!row.can_view, add: !!row.can_add, remove: !!row.can_remove, move: !!row.can_move, edit_details: !!row.can_edit_details, grant: !!row.can_grant } }),
      device_id: null,
    });
  });
}

/** Delete a grant. Composite-key outbox DELETE + activity log, atomic. */
export function revokeUnitAccess(locationId: string, userId: string): void {
  runInTransaction(() => {
    const db = getDb();
    db.executeSync(`DELETE FROM unit_access WHERE location_id = ? AND user_id = ?`, bindParams([locationId, userId]));
    appendOutbox('DELETE', 'unit_access', { location_id: locationId, user_id: userId });
    appendLog({
      action: 'locker_access_revoked', entity_type: 'location', entity_id: locationId,
      user_id: null, team_id: null, job_id: null,
      note: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
      metadata: JSON.stringify({ grantee_user_id: userId }), device_id: null,
    });
  });
}
