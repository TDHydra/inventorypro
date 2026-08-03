// #234: pickAccessGrantor (requestAccess.ts's findAccessGrantor, asking for a
// 'manage_roles_permissions' holder) returns null when nobody else on the
// roster's EFFECTIVE permissions (through the real override-aware
// hasPermission chain) currently include that grant — a genuine dead end for
// the "No one found" Alert today. Rather than stopping there, fall back to
// any other active full_admin: tier-4 always gets manage_roles_permissions by
// ROLE_DEFAULTS, so a full_admin existing at all is a reasonable last resort
// even in the edge case their row has a permission_overrides entry revoking
// it (this fallback intentionally checks ROLE, not effective permissions —
// it's answering "is there anyone in the top role" rather than re-deriving
// what pickAccessGrantor already ruled out).
//
// Pure and DI'd like requestAccess.ts (no db/react-native imports) so it runs
// under plain node:test; the real caller (SyncIndicator.tsx) supplies the
// active-user roster.
import type { CandidateRef, Grantor } from './requestAccess';

/**
 * Deterministic: alphabetical by name, same tie-break precedent as
 * findAccessGrantor's `closest()`, so repeated calls against the same
 * roster pick the same person.
 */
export function pickFallbackFullAdmin(
  candidates: CandidateRef[],
  currentUserId: string,
): Grantor | null {
  const admins = candidates
    .filter(c => c.id !== currentUserId && c.role === 'full_admin')
    .sort((a, b) => a.name.localeCompare(b.name));
  return admins[0] ? { id: admins[0].id, name: admins[0].name } : null;
}
