import { buildUserSession } from './session';
import type { UserSession } from './permissions';
import { setMaintenanceRole } from '../db/maintenance';
import { appendLog } from '../db/queries/log';
import { applyUserTheme } from '../db/userPrefs';
import { applyOrgDefaultTheme } from '../db/orgTheme';

/**
 * Builds the in-memory session for a freshly-authenticated user, wires the
 * maintenance exemption, writes a best-effort login audit entry, and pushes
 * the session into context. Shared by the returning-user login path and the
 * post-enrollment download screen so both behave identically.
 *
 * v2 slim: the old app's demo/sandbox handoff is dropped (test accounts are
 * not part of the rebuild's skeleton), and push registration / location
 * priming return with their surfaces in later waves.
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

  // Authentication is never a data mutation — signing in must NEVER be blocked
  // by maintenance mode. The login audit is best-effort: if the write-guard
  // (or anything) throws, swallow it so the user still gets in.
  try {
    appendLog({
      user_id: session.id,
      team_id: null,
      action: 'login',
      entity_type: 'user',
      entity_id: session.id,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: null,
      metadata: null,
      device_id: null,
    });
  } catch {
    /* maintenance lock or transient write error — sign-in proceeds regardless */
  }

  // Theme precedence at login: org default (app_config, arrived with the full
  // download) unless this user picked their own; then their synced pick.
  try { applyOrgDefaultTheme(session.id); applyUserTheme(session.id); } catch { /* keep the device theme */ }

  setUser(session);
  return true;
}
