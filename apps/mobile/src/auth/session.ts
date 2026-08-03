import * as SecureStore from 'expo-secure-store';
import { UserSession, TeamContext, parsePermissionOverrides } from './permissions';
import { getUserById } from '../db/queries/users';
import { getDb, rowsAs } from '../db/schema';
import { TEAM_OVERRIDABLE_PERMISSIONS } from '../db/queries/teams';
import { noteSessionExpired } from './sessionExpiredBus';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
if (!__DEV__ && !API_BASE.startsWith('https://')) {
  throw new Error('EXPO_PUBLIC_API_URL must be https in production');
}
const JWT_KEY = 'inventorypro_jwt';
const REFRESH_KEY = 'inventorypro_refresh';
const USER_ID_KEY = 'inventorypro_user_id';

export async function saveSession(jwt: string, refreshToken: string, userId: string): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(JWT_KEY, jwt),
    SecureStore.setItemAsync(REFRESH_KEY, refreshToken),
    SecureStore.setItemAsync(USER_ID_KEY, userId),
  ]);
}

export async function getJwt(): Promise<string | null> {
  return SecureStore.getItemAsync(JWT_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_KEY);
}

// Decode a JWT's `exp` (seconds since epoch) without verifying the signature.
// Returns null if it can't be parsed — callers treat that as "let the server decide".
function decodeJwtExp(jwt: string): number | null {
  try {
    const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    // atob is available in Hermes (RN 0.74+); guard just in case.
    if (typeof atob !== 'function') return null;
    const obj = JSON.parse(atob(b64));
    return typeof obj.exp === 'number' ? obj.exp : null;
  } catch {
    return null;
  }
}

/**
 * Return a JWT that should be accepted by the server right now. If the stored
 * 15-minute JWT is expired (or about to be), mint a fresh one from the 30-day
 * refresh token via /auth/refresh. Falls back to the existing token when offline
 * or when refresh isn't possible, so sync degrades gracefully instead of dying.
 */
export async function getValidJwt(): Promise<string | null> {
  const jwt = await getJwt();
  if (jwt) {
    const exp = decodeJwtExp(jwt);
    if (exp === null) return jwt;                      // unknown expiry — let server judge
    if (exp * 1000 > Date.now() + 30_000) return jwt;  // still good for >30s
  }

  const refresh = await getRefreshToken();
  if (!refresh) return jwt;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (res.status === 401 || res.status === 403) {
      // The server DEFINITIVELY rejected the refresh token — the session is
      // dead (expired/revoked/deactivated). Tell the app to log out instead
      // of handing back a JWT that will 401 forever.
      noteSessionExpired();
      return null;
    }
    if (!res.ok) return jwt;                            // 5xx/transient — keep existing
    const data = await res.json() as { jwt: string };
    await SecureStore.setItemAsync(JWT_KEY, data.jwt);
    return data.jwt;
  } catch {
    return jwt;                                         // offline — keep existing
  }
}

/**
 * Called by sync when a request 401s: the JWT the server just refused may be
 * revoked BEFORE its exp (server-side logout), which getValidJwt()'s local
 * expiry check can't see. Settle it by asking /auth/refresh directly — a
 * definite rejection (or no refresh token at all) means the session is dead;
 * success mints a fresh JWT for the next cycle; network errors decide nothing.
 */
export async function revalidateSession(): Promise<void> {
  const refresh = await getRefreshToken();
  if (!refresh) {
    noteSessionExpired();
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (res.status === 401 || res.status === 403) {
      noteSessionExpired();
      return;
    }
    if (res.ok) {
      const data = await res.json() as { jwt: string };
      await SecureStore.setItemAsync(JWT_KEY, data.jwt);
    }
  } catch {
    /* offline/transient — decide nothing */
  }
}

export async function getSavedUserId(): Promise<string | null> {
  return SecureStore.getItemAsync(USER_ID_KEY);
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(JWT_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
    SecureStore.deleteItemAsync(USER_ID_KEY),
  ]);
}

export async function hasActiveSession(): Promise<boolean> {
  const [jwt, userId] = await Promise.all([getJwt(), getSavedUserId()]);
  if (!jwt || !userId) return false;
  // Also verify user is still active in local DB (could have been deactivated via sync)
  const user = getUserById(userId);
  return !!user && user.active === 1;
}

/**
 * A returning user that can unlock with biometrics: a refresh token + user id
 * are persisted from a prior online sign-in, and that user is still active
 * locally. The 15-minute JWT may be expired — getValidJwt() mints a fresh one
 * after unlock — so we deliberately do NOT require it here.
 */
export async function hasStoredSession(): Promise<boolean> {
  const [refresh, userId] = await Promise.all([getRefreshToken(), getSavedUserId()]);
  if (!refresh || !userId) return false;
  const user = getUserById(userId);
  return !!user && user.active === 1;
}

// Per-member team overrides are stored as a JSON string and may only carry the
// TEAM_OVERRIDABLE_PERMISSIONS allowlist. A team-scoped grant must never confer
// account/system authority (manage_users, manage_roles_permissions,
// system_settings, view_audit_log, …), so filter to the allowlist here — a
// tampered/legacy row can't widen a member's authority past what the team editor
// can set, and org-admin remains a strict role/tier test (isOrgAuthority).
function buildTeamContexts(userId: string): TeamContext[] {
  try {
    // Built here (not at module scope) to sidestep the session↔teams import
    // cycle: at module-eval the allowlist may still be undefined, which would
    // yield an empty set and silently strip every override.
    const overridable = new Set<string>(TEAM_OVERRIDABLE_PERMISSIONS);
    const db = getDb();
    const result = db.executeSync(
      `SELECT team_id, team_permission_overrides FROM team_members WHERE user_id = ?`,
      [userId],
    );
    const rows = rowsAs<{ team_id: string; team_permission_overrides: string }>(result.rows);
    return rows.map(r => {
      const parsed = parsePermissionOverrides(r.team_permission_overrides);
      const filtered: Record<string, boolean> = {};
      for (const [perm, allowed] of Object.entries(parsed)) {
        if (overridable.has(perm)) filtered[perm] = allowed;
      }
      return { team_id: r.team_id, team_permission_overrides: filtered };
    });
  } catch {
    // team_members not ready (pre-migration / transient) — team overrides simply
    // don't apply this session rather than blocking login.
    return [];
  }
}

export function buildUserSession(userId: string): UserSession | null {
  const user = getUserById(userId);
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    permission_overrides: parsePermissionOverrides(user.permission_overrides),
    pin_length_required: user.pin_length_required,
    active: user.active,
    expires_at: user.expires_at,
    team_contexts: buildTeamContexts(user.id),
    is_test: user.is_test ?? 0,
  };
}
