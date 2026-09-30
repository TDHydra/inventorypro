import { upsertUnitAccess, type UnitAccessUpsert } from '../db/queries/unitAccess';
import { getDefaultActionsForRole, type UnitAccessActions } from '../db/unitAccessDefaults';

/** Pure row shaper — exported for tests. */
export function buildDefaultGrantRow(
  locationId: string, userId: string, actions: UnitAccessActions,
  actorUserId: string | null, nowIso: string,
): UnitAccessUpsert {
  return {
    location_id: locationId, user_id: userId,
    can_view: actions.view ? 1 : 0, can_add: actions.add ? 1 : 0,
    can_remove: actions.remove ? 1 : 0, can_move: actions.move ? 1 : 0,
    can_edit_details: actions.editDetails ? 1 : 0, can_grant: actions.grant ? 1 : 0,
    granted_by: actorUserId, created_at: nowIso, updated_at: nowIso,
  };
}

/**
 * Create a grant with the admin's per-role defaults auto-applied (#122 Phase B).
 * upsertUnitAccess (A1) owns the local write + outbox + activity log; editing
 * the grant afterwards goes through upsertUnitAccess directly.
 */
export function grantUnitAccessWithDefaults(
  locationId: string, userId: string, granteeRole: string, actorUserId: string | null,
): void {
  upsertUnitAccess(buildDefaultGrantRow(
    locationId, userId, getDefaultActionsForRole(granteeRole), actorUserId, new Date().toISOString(),
  ));
}
