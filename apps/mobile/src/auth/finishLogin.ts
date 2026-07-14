import { buildUserSession } from './session';
import type { UserSession } from './permissions';
import { setMaintenanceRole } from '../db/maintenance';
import { appendLog } from '../db/queries/log';
import { registerForPush } from '../push/register';
import { setSandboxActive } from '../sync/sandbox';
import { setAppSetting, deleteAppSetting } from '../db/appSettings';

/** app_settings flag: a test session is (or was) live on this device. Read at
 * startup so a demo session killed mid-run still gets wiped on next launch. */
export const TEST_SESSION_FLAG = 'test_session_active';

/**
 * Builds the in-memory session for a freshly-authenticated user, wires the
 * maintenance exemption, writes a best-effort login audit entry, and pushes the
 * session into context. Shared by the returning-user login path and the
 * post-enrollment download screen so both behave identically.
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

  // Sandbox test/demo sessions BEFORE any write: sync goes dormant (no push, no
  // pull) and the crash flag makes a killed demo wipe on next launch. Real
  // logins clear both, in case a prior test session's state lingers.
  const isTestSession = !!session.is_test;
  setSandboxActive(isTestSession);
  try {
    if (isTestSession) setAppSetting(TEST_SESSION_FLAG, '1');
    else deleteAppSetting(TEST_SESSION_FLAG);
  } catch { /* settings write is best-effort; logout wipe still covers it */ }

  // Authentication is never a data mutation — signing in must NEVER be blocked by
  // maintenance mode. The login audit is best-effort: if the write-guard (or
  // anything) throws, swallow it so the user still gets in. Test sessions skip
  // it entirely — their audit rows would only ever be throwaway sandbox data.
  if (!isTestSession) try {
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

  setUser(session);

  // Best-effort push token registration — fire-and-forget, never awaited and
  // never allowed to affect the login result (registerForPush swallows its
  // own errors, including permission-denied/offline/unsupported-platform).
  // Test sessions skip it: registration is a server write (403 for them) and a
  // shared demo device must never receive a real user's pushes.
  if (!isTestSession) registerForPush().catch(() => {});

  return true;
}
