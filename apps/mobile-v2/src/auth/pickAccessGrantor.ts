// Wires the pure `findAccessGrantor` (requestAccess.ts) to the real app: the
// active-user roster (db/queries/users) + the real `hasPermission` chain
// (permissions.ts). Deliberately kept OUT of requestAccess.ts — this file's
// imports pull in the native op-sqlite binding, which crashes outside the app
// (see requestAccess.ts's header comment). Anything that needs to actually
// pick a grantor at runtime (PermissionGate, SyncIndicator) calls
// `pickAccessGrantor` from here; anything testing the SELECTION LOGIC imports
// `findAccessGrantor` from requestAccess.ts directly with a fake `holds`.
import { getAllActiveUsers } from '../db/queries/users';
import { hasPermission, parsePermissionOverrides, type UserSession } from './permissions';
import type { Permission } from '../constants/roles';
import { findAccessGrantor, type CandidateRef, type Grantor } from './requestAccess';

export function pickAccessGrantor(
  permission: Permission,
  currentUser: Pick<UserSession, 'id' | 'name' | 'role'>,
): Grantor | null {
  const users = getAllActiveUsers();
  const candidates: CandidateRef[] = users.map(u => ({ id: u.id, name: u.name, role: u.role }));

  function sessionFor(id: string): UserSession | undefined {
    const row = users.find(u => u.id === id);
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      permission_overrides: parsePermissionOverrides(row.permission_overrides),
      pin_length_required: row.pin_length_required,
      active: row.active,
      expires_at: row.expires_at,
    };
  }

  function holds(candidate: CandidateRef, perm: Permission): boolean {
    const session = sessionFor(candidate.id);
    return session ? hasPermission(session, perm) : false;
  }

  return findAccessGrantor(permission, currentUser, candidates, holds);
}
