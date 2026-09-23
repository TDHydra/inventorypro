import { canActOnTarget, effectiveTier } from './permissions';

// Who may create/edit/revoke a unit_access grant (#122 Phase B) — the single
// policy the /sync/push per-row guard (routes/sync.ts) enforces and the mobile
// mirror (apps/mobile/src/access/unitAccessPolicy.ts) copies for courtesy
// gating. KEEP IN SYNC with mobile.
//
//   owner                                → always (it's their unit)
//   manager of a team the owner is on ──┐
//   production_manager                  ├─ only when they out-tier the GRANTEE
//   tier-3+ org authority             ──┘  (canActOnTarget — fails closed on
//                                           unknown roles / missing users)
export interface UnitAccessEditFacts {
  callerId: string;
  callerRole: string | null | undefined;
  /** locations.owner_user_id — DB truth, never the payload's. */
  ownerUserId: string | null;
  /** caller has is_manager on a team the owner belongs to. */
  callerManagesOwnersTeam: boolean;
  /** users.role of the grant's target user (null = unknown user → fail closed). */
  granteeRole: string | null;
}

export function canManageUnitAccess(f: UnitAccessEditFacts): boolean {
  if (f.ownerUserId != null && f.ownerUserId === f.callerId) return true;
  const privileged =
    (effectiveTier(f.callerRole) ?? 0) >= 3
    || f.callerRole === 'production_manager'
    || f.callerManagesOwnersTeam;
  if (!privileged) return false;
  return canActOnTarget(f.callerRole, f.granteeRole);
}
