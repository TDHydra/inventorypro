import { UserSession, TeamContext, parsePermissionOverrides } from './permissions';
import { getUserById } from '../db/queries/users';
import { getDb, rowsAs } from '../db/schema';
import { TEAM_OVERRIDABLE_PERMISSIONS } from '../db/queries/teams';
import { clearDbSnapshot } from '../db/webPersistence';
import { clearSnapshotKey } from '../db/webCrypto';
import { installWebIdleWipe } from '../hooks/useWebIdleWipe';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const JWT_KEY = 'inventorypro_jwt';
const REFRESH_KEY = 'inventorypro_refresh';
const USER_ID_KEY = 'inventorypro_user_id';

// The refresh token is long-lived (30 days) and, unlike the 15-minute JWT, is
// deliberately NOT persisted to IndexedDB on web — anything written there sits
// on disk in plaintext and readable by anyone with local file access. Keeping
// it only in this module-scoped variable means a page reload drops it, so the
// user falls back to PIN/login instead of silently resuming a long-lived
// session from disk. See D4 in the 2026-07-01 security audit remediation plan.
let inMemoryRefreshToken: string | null = null;

// ── Minimal IndexedDB kv store (web replacement for expo-secure-store) ────────
// Shares the same DB/store names as the sql.js snapshot persistence so the web
// build keeps a single IndexedDB database.
const IDB_NAME = 'inventorypro-web';
const IDB_STORE = 'kv';

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<string | null> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result == null ? null : (req.result as string));
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: string): Promise<void> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key: string): Promise<void> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveSession(jwt: string, refreshToken: string, userId: string): Promise<void> {
  inMemoryRefreshToken = refreshToken;
  await Promise.all([
    idbSet(JWT_KEY, jwt),
    idbSet(USER_ID_KEY, userId),
    // Purge any refresh token persisted by a pre-D4 build so nothing long-lived
    // is left at rest, even though we no longer write one here.
    idbDel(REFRESH_KEY),
  ]);
}

export async function getJwt(): Promise<string | null> {
  return idbGet(JWT_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return inMemoryRefreshToken;
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
    if (!res.ok) return jwt;                            // refresh rejected — keep existing
    const data = await res.json() as { jwt: string };
    await idbSet(JWT_KEY, data.jwt);
    return data.jwt;
  } catch {
    return jwt;                                         // offline — keep existing
  }
}

export async function getSavedUserId(): Promise<string | null> {
  return idbGet(USER_ID_KEY);
}

export async function clearSession(): Promise<void> {
  await wipeWebSecureState();
}

/**
 * Wipe ALL sensitive web state: the in-memory refresh token, the persisted JWT /
 * user id, AND the encrypted DB snapshot together with its AES key (in memory +
 * sessionStorage). After this, nothing on disk is decryptable and the user must
 * re-authenticate. Called from the logout path (clearSession) and from the idle
 * auto-wipe below.
 */
export async function wipeWebSecureState(): Promise<void> {
  inMemoryRefreshToken = null;
  await Promise.all([
    idbDel(JWT_KEY),
    idbDel(REFRESH_KEY),
    idbDel(USER_ID_KEY),
    // Delete the encrypted snapshot and drop its key. clearDbSnapshot() already
    // calls clearSnapshotKey(); the extra call is a defensive no-op belt-and-braces.
    clearDbSnapshot().catch(() => { /* best-effort */ }),
  ]);
  clearSnapshotKey();
}

// ── Web idle auto-wipe ────────────────────────────────────────────────────────
// Native uses `useIdleLogout` (RN AppState + touch responder). The browser has
// no equivalent, so we install a document-level idle listener at module load
// (this module is imported early on web via the shared `../auth/session` path).
// After ~15 min of no interaction it wipes tokens + the encrypted DB key, so a
// walked-away session on a shared machine can't be resumed. Guarded to the
// browser inside installWebIdleWipe(); a no-op during SSR / tests.
//
// NOTE: this wipes secure state but cannot flip the in-memory React session to
// null on its own (that lives in the SessionContext provider in app/_layout.tsx,
// outside these editable files). The next authed action / route guard will see
// the missing token and bounce to login. TODO: for an *immediate* redirect on
// idle, also drive the provider's `logout()` from the web mount — e.g. call
// `installWebIdleWipe(logout)` (or add a subscriber) from app/_layout.tsx or a
// web-only session hook, replacing the token-only wipe wired here.
installWebIdleWipe(() => { void wipeWebSecureState(); });

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
  };
}
