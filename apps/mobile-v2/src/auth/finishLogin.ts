import { buildUserSession } from './session';
import type { UserSession } from './permissions';
import { setMaintenanceRole } from '../db/maintenance';
import { applyUserTheme } from '../db/userPrefs';
import { applyOrgDefaultTheme } from '../db/orgTheme';

/**
 * Builds the in-memory session for a freshly-authenticated user, wires the
 * maintenance exemption, and pushes the session into context. Shared by the
 * returning-user login path and the post-enrollment download screen so both
 * behave identically.
 *
 * v2 slim: the old app's demo/sandbox handoff is dropped (test accounts are
 * not part of the rebuild's skeleton), and push registration / location
 * priming return with their surfaces in later waves.
 *
 * No client-side login audit row: /auth/token writes the authoritative
 * activity_log 'login' row server-side (with request-id metadata), and the
 * sync policy marks the action serverOnly — the old app's client-side
 * appendLog('login') was permanently denied on every push and only ever
 * accumulated in the denied bucket. The server row reaches the device via
 * pull like any other activity.
 *
 * Returns false when the user can't be resolved locally (caller should surface
 * "User not found on this device"). Navigation stays with the caller.
 */
export function finishLogin(userId: string, setUser: (s: UserSession) => void): boolean {
  const session = buildUserSession(userId);
  if (!session) return false;

  // Wire the maintenance exemption for THIS user before any write, so a tier-4
  // admin signing in during maintenance isn't treated as non-exempt.
  setMaintenanceRole(session.role);

  // Theme precedence at login: org default (app_config, arrived with the full
  // download) unless this user picked their own; then their synced pick.
  try { applyOrgDefaultTheme(session.id); applyUserTheme(session.id); } catch { /* keep the device theme */ }

  setUser(session);
  return true;
}
