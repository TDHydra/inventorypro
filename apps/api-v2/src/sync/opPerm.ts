import { isOrgAuthority } from '../lib/teamAuthority';
import { requiredOperationPerm } from '../lib/syncPolicy';
import type { OutboxEntry, Pg, Rejection, SyncCtx } from './types';

// #84: may a caller WITHOUT manage_locations INSERT this locations row? Only
// when the org has opted in (app_config crew_add_vehicle_enabled = '1' —
// system_settings-gated, read server-side like maintenance_mode) AND the row
// resolves to a Vehicle-type location (label, or type_id when the label is
// absent). Fails closed on any lookup error — this is an exemption, not a right.
async function crewVehicleInsertAllowed(pg: Pg, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const { rows } = await pg.query(
      `SELECT value FROM app_config WHERE key = 'crew_add_vehicle_enabled'`, [],
    );
    if (!rows[0] || (rows[0] as { value: string }).value !== '1') return false;
    if (payload.type != null) return String(payload.type) === 'Vehicle';
    if (payload.type_id != null) {
      const { rows: t } = await pg.query(
        `SELECT 1 FROM taxonomy_types WHERE id = $1 AND category = 'location_type' AND label = 'Vehicle'`,
        [payload.type_id],
      );
      return !!t[0];
    }
    return false;
  } catch {
    return false;
  }
}

// May a caller WITHOUT manage_locations INSERT this locations row as a Shelf?
// A stock recount/add auto-creates a Shelf under the location being counted, so
// a checkin_inventory/checkout_inventory holder (checked at the call site via
// `can` — this only resolves the row's type) must be able to land the Shelf row
// itself: without this the shelf INSERT is Forbidden-dropped client-side and
// the follow-up stock_by_location INSERT referencing it FK-violates forever.
// Only Shelf-type rows qualify (label, or type_id when the label is absent) —
// every other locations write stays behind manage_locations. Fails closed on
// any lookup error — this is an exemption, not a right.
async function crewShelfInsertAllowed(pg: Pg, payload: Record<string, unknown>): Promise<boolean> {
  try {
    if (payload.type != null) return String(payload.type) === 'Shelf';
    if (payload.type_id != null) {
      const { rows: t } = await pg.query(
        `SELECT 1 FROM taxonomy_types WHERE id = $1 AND category = 'location_type' AND label = 'Shelf'`,
        [payload.type_id],
      );
      return !!t[0];
    }
    return false;
  } catch {
    return false;
  }
}

// H2: true when this locations payload would CREATE a new row (no id, or an id
// that does not yet exist), false when it would upsert over an existing one.
// `locations` isn't in INSERT_NO_UPSERT, so the generic writer runs
// `INSERT ... ON CONFLICT (id) DO UPDATE` — an "INSERT" carrying an EXISTING id
// is a full-row overwrite. The crew vehicle/shelf carve-outs only ever justify
// CREATING a row, never editing an existing location, so gate them on this.
// Fails CLOSED (false) on a non-string id or lookup error so a hostile payload
// can't masquerade as "new".
async function locationIdIsNew(pg: Pg, payload: Record<string, unknown>): Promise<boolean> {
  const id = payload?.id;
  if (id == null) return true; // no id supplied → a genuine create, not an overwrite
  if (typeof id !== 'string') return false;
  try {
    const { rows } = await pg.query(`SELECT 1 FROM locations WHERE id = $1`, [id]);
    return rows.length === 0;
  } catch {
    return false;
  }
}

// Operational-table authorization — gate writes on the per-operation
// permission. Runs between the privileged phase and the authorizeRow guards
// (same position as the old monolith's op-perm chain). Returns a Rejection to
// refuse the entry, undefined to let it through.
export async function checkOperationPermission(ctx: SyncCtx, entry: OutboxEntry): Promise<Rejection | undefined> {
  const { pg, userId, caller, can, log } = ctx;
  // ADJUST is the signed-delta checkout/checkin path on stock_by_location; it
  // requires checkin_inventory or checkout_inventory rather than the generic
  // op-perm map (any authenticated user was previously able to mutate stock
  // via ADJUST — closed here).
  if (entry.operation === 'ADJUST') {
    if (!can('checkin_inventory') && !can('checkout_inventory')) {
      log.warn(
        { userId, role: caller.role, table: entry.table_name, operation: entry.operation },
        'sync push ADJUST denied (authz)',
      );
      return { error: 'Forbidden: stock adjust requires checkin/checkout permission', code: 'FORBIDDEN' };
    }
    // Hard locker enforcement (#126, user decision 2026-07-18): a NEGATIVE
    // delta (taking stock) from a Locker-typed location is allowed only for
    // the owner ∪ an explicit locker_access grantee ∪ someone who shares a
    // TEAM with the owner ∪ org authority (tier 3+, checked first so the
    // lookup is skipped). Positive deltas (restocking a locker) stay open,
    // and non-Locker locations are untouched. The rejection wording matches
    // /forbidden|cannot|not allowed/i so the mobile engine classifies it
    // permanent and DROPS the entry (an offline-revoked checkout must not
    // retry-loop — accepted race, the activity log still records it).
    // NOTE Phase 8: locker_access is slated for DROP (≥082) — when that
    // migration lands, replace the la-subquery with the unit_access model.
    const adjDelta = Number((entry.payload as { delta?: unknown }).delta);
    if (Number.isFinite(adjDelta) && adjDelta < 0 && !isOrgAuthority(caller.role)) {
      let lockerDenied = false;
      try {
        const { rows: lockRows } = await pg.query(
          `SELECT l.type,
                  (l.owner_user_id = $2) AS is_owner,
                  EXISTS (SELECT 1 FROM locker_access la
                           WHERE la.location_id = l.id AND la.user_id = $2) AS has_grant,
                  EXISTS (SELECT 1 FROM team_members om
                            JOIN team_members cm ON cm.team_id = om.team_id
                           WHERE om.user_id = l.owner_user_id AND cm.user_id = $2) AS shares_team
             FROM locations l WHERE l.id = $1`,
          [entry.payload.location_id, userId],
        );
        const lock = lockRows[0] as
          | { type: string | null; is_owner: boolean | null; has_grant: boolean; shares_team: boolean }
          | undefined;
        lockerDenied = !!lock && lock.type === 'Locker'
          && lock.is_owner !== true && !lock.has_grant && !lock.shares_team;
      } catch {
        // Lookup failure is transient — surface a NON-permanent conflict so
        // the entry retries instead of being silently dropped.
        return { error: 'locker access check failed', code: 'CONFLICT' };
      }
      if (lockerDenied) {
        log.warn(
          { userId, role: caller.role, locationId: entry.payload.location_id, delta: adjDelta },
          'sync push ADJUST denied (locker access)',
        );
        return { error: 'Forbidden: you do not have access to this locker', code: 'FORBIDDEN' };
      }
    }
    return undefined;
  }

  if (entry.table_name === 'inventory_items' && entry.operation === 'UPDATE' && entry.payload.active === false) {
    // Deactivating an item IS the delete (items are soft-deleted, never row-
    // deleted). The generic UPDATE op-perm is only `edit_inventory`, so gate
    // the active:false case on the stricter `delete_inventory` — otherwise the
    // UI's delete gate would be advisory-only and an edit_inventory-only role
    // could deactivate items via a crafted push.
    if (!can('delete_inventory')) {
      return { error: 'Forbidden: deactivating an item requires delete_inventory', code: 'FORBIDDEN' };
    }
    return undefined;
  }

  if (
    entry.table_name === 'vehicle_service_records'
    && entry.operation === 'INSERT'
    && entry.payload.type === 'fuel_up'
  ) {
    // #76/#168 fuel_up carve-out (live regression on gas receipts):
    // AddServiceRecordSheet locks non-editors to the Fuel-up kind — any crew
    // member may file a gas receipt — but the generic OPERATION_PERM for
    // vehicle_service_records is edit_inventory, which would wrongly reject
    // that write. Strict equality against the ONE known carve-out kind: any
    // other `type` string falls through to the generic gate below, as do
    // UPDATE/DELETE on fuel_up rows regardless of kind.
    // One financial exception: the client only offers the cost field to
    // view_financial_data holders, so a non-null cost requires
    // view_financial_data or edit_inventory. Blocks a forged crew push from
    // planting costs; everything else passes unconditionally.
    if (entry.payload.cost != null && !can('view_financial_data') && !can('edit_inventory')) {
      return { error: 'Forbidden: cost on a fuel_up requires edit_inventory or view_financial_data', code: 'FORBIDDEN' };
    }
    return undefined;
  }

  if (
    entry.table_name === 'rooms'
    && (entry.operation === 'INSERT' || entry.operation === 'UPDATE')
  ) {
    // #173 rooms carve-out: OPERATION_PERM only maps a table+op to ONE
    // required permission, but rooms is quick-addable by anyone who can
    // either upload media (the job-photo flow that motivated it) OR edit
    // inventory (existing catalog-table editors). DELETE deliberately NOT
    // matched here: it falls through to the generic gate below, which denies
    // it (rooms has no OPERATION_PERM DELETE entry).
    if (!can('upload_media') && !can('edit_inventory')) {
      return { error: 'Forbidden: rooms requires upload_media or edit_inventory', code: 'FORBIDDEN' };
    }
    return undefined;
  }

  const opPerm = requiredOperationPerm(entry.table_name, entry.operation as 'INSERT' | 'UPDATE' | 'DELETE');
  if (opPerm === 'DENY') {
    return { error: `Forbidden: ${entry.table_name}/${entry.operation} not permitted via sync`, code: 'NOT_ALLOWED' };
  }
  if (opPerm && !can(opPerm)) {
    // #84: a crew member without manage_locations may still INSERT a location
    // when the org flag is on AND the row is a Vehicle ("add a vehicle" from
    // the fast-checkout source picker). Everything else stays gated exactly
    // as before.
    // H2: the crew carve-outs may only CREATE a new location — never upsert
    // over an existing row via ON CONFLICT DO UPDATE. Require the target id
    // to be new; otherwise the write stays gated behind manage_locations
    // (falls through to the FORBIDDEN branch below).
    const crewLocationCreate = entry.table_name === 'locations'
      && entry.operation === 'INSERT'
      && await locationIdIsNew(pg, entry.payload);
    const crewVehicleOk = crewLocationCreate
      && await crewVehicleInsertAllowed(pg, entry.payload);
    // A stock-mover (checkin/checkout) may INSERT the auto-created Shelf a
    // recount/add lands on — see crewShelfInsertAllowed.
    const crewShelfOk = !crewVehicleOk
      && crewLocationCreate
      && (can('checkin_inventory') || can('checkout_inventory'))
      && await crewShelfInsertAllowed(pg, entry.payload);
    if (!crewVehicleOk && !crewShelfOk) {
      log.warn(
        { userId, role: caller.role, table: entry.table_name, operation: entry.operation, opPerm },
        'sync push op denied (authz)',
      );
      return { error: `Forbidden: ${entry.table_name}/${entry.operation} requires ${opPerm}`, code: 'FORBIDDEN' };
    }
  }
  return undefined;
}
