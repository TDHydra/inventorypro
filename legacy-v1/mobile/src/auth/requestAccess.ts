// #203 "Request access" funnel — choosing WHO to ask when a PermissionGate
// tap or a denied sync entry reveals a missing permission.
//
// Pure and DI'd on purpose: `findAccessGrantor` never touches the DB or the
// real `hasPermission` chain directly — the caller supplies the candidate
// pool and a `holds` callback (in practice, real callers close over the app's
// actual `hasPermission` from ./permissions + the active-user roster from
// db/queries/users; see the wiring in PermissionGate.tsx / SyncIndicator.tsx).
// That keeps this file free of react-native/db imports so it runs under plain
// `node:test` via tsx (same precedent as denialMessages.ts, toastBus.ts,
// confirmQueue.ts) — importing `auth/permissions.ts` as a VALUE here would
// transitively pull in the native op-sqlite binding via db/queries/users.ts
// and crash outside the app (see useSession.test.ts's identical note).
//
// KEEP IN SYNC conceptually with permissions.ts's hasPermission resolution
// order — the `holds` callback a real caller passes IS that chain, this file
// just orchestrates candidate selection on top of it.

import type { UserRole, Permission } from '../constants/roles';
import { ROLE_TIER } from '../constants/roles';

export interface Grantor {
  id: string;
  name: string;
}

/** The minimal shape findAccessGrantor needs for tie-breaking + identity. */
export interface CandidateRef {
  id: string;
  name: string;
  role: UserRole;
}

function tierDistance(a: UserRole, b: UserRole): number {
  return Math.abs((ROLE_TIER[a] ?? 0) - (ROLE_TIER[b] ?? 0));
}

// Deterministic tie-break: closest role tier to the requester first (a peer
// or near-peer is a more natural person to ask than someone many tiers away),
// then alphabetical by name so repeated calls with the same inputs always
// pick the same person.
function closest(role: UserRole, pool: CandidateRef[]): CandidateRef | null {
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) =>
    tierDistance(role, a.role) - tierDistance(role, b.role) || a.name.localeCompare(b.name)
  )[0];
}

/**
 * Choose who to ask for a missing permission.
 *
 * Selection order:
 * 1. Exclude the requester themself.
 * 2. Prefer someone who holds BOTH `permission` and `manage_roles_permissions`
 *    — they can grant it on the spot without needing to escalate further.
 * 3. Else anyone who simply holds `permission` (they can vouch/act on the
 *    requester's behalf even if they can't grant it directly).
 * 4. Else (nobody holds `permission` at all) fall back to any
 *    `manage_roles_permissions` holder — someone who CAN grant it.
 * Returns null only if none of the three pools has a single candidate.
 */
export function findAccessGrantor(
  permission: Permission,
  currentUser: CandidateRef,
  candidates: CandidateRef[],
  holds: (candidate: CandidateRef, permission: Permission) => boolean,
): Grantor | null {
  const others = candidates.filter(c => c.id !== currentUser.id);
  const holders = others.filter(c => holds(c, permission));
  const roleManagers = others.filter(c => holds(c, 'manage_roles_permissions'));
  const roleManagerIds = new Set(roleManagers.map(c => c.id));
  const preferred = holders.filter(c => roleManagerIds.has(c.id));

  const chosen =
    closest(currentUser.role, preferred)
    ?? closest(currentUser.role, holders)
    ?? closest(currentUser.role, roleManagers);

  return chosen ? { id: chosen.id, name: chosen.name } : null;
}
