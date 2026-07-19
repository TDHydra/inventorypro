import { ROLE_TIER, canActOnTarget, type UserRole } from '../constants/roles';

// Mobile mirror of the server's unit_access write policy
// (apps/api/src/lib/unitAccessPolicy.ts) — courtesy gating only; /sync/push is
// the enforcement of record. KEEP IN SYNC.
export interface UnitAccessEditFacts {
  callerId: string;
  callerRole: string | null | undefined;
  ownerUserId: string | null;
  callerManagesOwnersTeam: boolean;
  granteeRole: string | null;
}

export function canManageUnitAccess(f: UnitAccessEditFacts): boolean {
  if (f.ownerUserId != null && f.ownerUserId === f.callerId) return true;
  const privileged =
    (f.callerRole != null && (ROLE_TIER[f.callerRole as UserRole] ?? 0) >= 3)
    || f.callerRole === 'production_manager'
    || f.callerManagesOwnersTeam;
  if (!privileged) return false;
  return canActOnTarget((f.callerRole ?? '') as UserRole, (f.granteeRole ?? '') as UserRole);
}
