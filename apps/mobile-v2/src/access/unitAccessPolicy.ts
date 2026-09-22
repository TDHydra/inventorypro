// Ported verbatim from apps/mobile/src/access/unitAccessPolicy.ts. Pure — no
// RN/db imports — so it's importable both from repos/access.ts and directly
// from UI (MemberPermissionsSheet, access/index.tsx) without a db round trip.
import { ROLE_TIER, canActOnTarget } from '../constants/roles';
import type { UserRole } from '../constants/roles';

export interface UnitAccessEditFacts {
  callerId: string;
  callerRole: string | null | undefined;
  ownerUserId: string | null;
  callerManagesOwnersTeam: boolean;
  granteeRole: string | null;
}

/**
 * Courtesy client-side gate for "can this caller edit this unit's access
 * grants" — the server (routes/sync.ts unit_access write policy) is the
 * enforcement of record. Mirrors the old app's canManageUnitAccess exactly:
 *   - the unit's owner can always manage their own grants;
 *   - otherwise the caller needs tier >= 3 (office_manager and up), OR to be
 *     a production_manager, OR to manage the owner's team — AND must be
 *     allowed to act on the target grantee's role (hierarchy guard).
 */
export function canManageUnitAccess(f: UnitAccessEditFacts): boolean {
  if (f.ownerUserId != null && f.ownerUserId === f.callerId) return true;
  const privileged = (f.callerRole != null && (ROLE_TIER[f.callerRole as UserRole] ?? 0) >= 3)
    || f.callerRole === 'production_manager' || f.callerManagesOwnersTeam;
  if (!privileged) return false;
  return canActOnTarget((f.callerRole ?? '') as UserRole, (f.granteeRole ?? '') as UserRole);
}
