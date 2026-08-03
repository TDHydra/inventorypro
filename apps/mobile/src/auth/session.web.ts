import { UserSession, TeamContext, parsePermissionOverrides } from './permissions';
import { getUserById } from '../db/queries/users';
import { getDb, rowsAs, resetLocalDb } from '../db/schema';
// markDbWiped/clearDbWiped are web-only. Import them from the explicit `.web`
// module: without `moduleSuffixes`, tsc resolves the bare `../db/schema` to the
// native schema.ts (which lacks these), while Metro resolves BOTH specifiers to
// schema.web.ts on web — the same module instance, so the persistWiped flag they
// toggle is the very one flush()/scheduleSave() read.
import { markDbWiped, clearDbWiped } from '../db/schema.web';
import { TEAM_OVERRIDABLE_PERMISSIONS } from '../db/queries/teams';
import { noteSessionExpired } from './sessionExpiredBus';
import {
  clearDbSnapshot,
  saveSecureValue,
  loadSecureValue,
  deleteSecureValue,
} from '../db/webPersistence';
import { clearSnapshotKey } from '../db/webCrypto';
import { installWebIdleWipe, getWebIdleLogoutHandler } from '../hooks/useWebIdleWipe';
import { appAlertBus, IDLE_NUDGE_TAG } from '../lib/alertBus';

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

// ── Encrypted kv persistence (web replacement for expo-secure-store) ──────────
// The JWT and user id are stored in the same IndexedDB database as the sql.js
// snapshot, but ENCRYPTED at rest with the shared AES-GCM snapshot key (see
// webPersistence.saveSecureValue / loadSecureValue). A local-disk attacker who
// can't decrypt the snapshot therefore can't lift a live JWT either. The
// snapshot key lives only in memory + sessionStorage, so when it's absent
// (fresh tab, post-logout, post-idle) these reads return null and the user is
// treated as logged-out — the values are never read back or written in plaintext.

export async function saveSession(jwt: string, refreshToken: string, userId: string): Promise<void> {
  inMemoryRefreshToken = refreshToken;
  // A genuine re-login: lift the post-wipe persistence block (markDbWiped) so the
  // fresh session's snapshot + encrypted JWT are written normally again. Done
  // BEFORE the encrypted writes below so getOrCreateSnapshotKey may mint a key.
  clearDbWiped();
  await Promise.all([
    saveSecureValue(JWT_KEY, jwt),
    saveSecureValue(USER_ID_KEY, userId),
    // Purge any refresh token persisted by a pre-D4 build so nothing long-lived
    // is left at rest, even though we no longer write one here.
    deleteSecureValue(REFRESH_KEY),
  ]);
}

export async function getJwt(): Promise<string | null> {
  return loadSecureValue(JWT_KEY);
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
    if (res.status === 401 || res.status === 403) {
      // Definitive rejection — dead session; the app must log out (see the
      // native twin session.ts for the full rationale).
      noteSessionExpired();
      return null;
    }
    if (!res.ok) return jwt;                            // 5xx/transient — keep existing
    const data = await res.json() as { jwt: string };
    await saveSecureValue(JWT_KEY, data.jwt);
    return data.jwt;
  } catch {
    return jwt;                                         // offline — keep existing
  }
}

/** Web twin of session.ts revalidateSession — see there for rationale. */
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
      await saveSecureValue(JWT_KEY, data.jwt);
    }
  } catch {
    /* offline/transient — decide nothing */
  }
}

export async function getSavedUserId(): Promise<string | null> {
  return loadSecureValue(USER_ID_KEY);
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
    deleteSecureValue(JWT_KEY),
    deleteSecureValue(REFRESH_KEY),
    deleteSecureValue(USER_ID_KEY),
    // Delete the encrypted snapshot and drop its key. clearDbSnapshot() already
    // calls clearSnapshotKey(); the extra call is a defensive no-op belt-and-braces.
    clearDbSnapshot().catch(() => { /* best-effort */ }),
  ]);
  clearSnapshotKey();
}

/**
 * Complete idle/logout wipe for web — the full logout the bare token wipe used to
 * only half-do. In order:
 *
 *  1. markDbWiped() FIRST, so from here on no debounced flush (and no migration
 *     flush inside resetLocalDb below) can re-mint an AES key and re-persist a
 *     decryptable snapshot — the re-persist race that used to undo the wipe.
 *  2. wipeWebSecureState() — drop the refresh token, the persisted JWT / user id,
 *     the encrypted snapshot, and the AES key (memory + sessionStorage).
 *  3. resetLocalDb() — CLOSE and clear the in-memory sql.js DB and re-init an
 *     empty one, so offline reads return nothing after the wipe. The normal
 *     logout path does NOT do this for a non-test session, which is exactly why a
 *     walked-away browser could still read everything; we do it explicitly here.
 *  4. Flip the React SessionContext to logged-out. We reuse the app root's own
 *     `logout()` (registered via setWebIdleLogoutHandler) rather than reinventing
 *     it. If none is registered yet (wipe fired before the root mounted), fall
 *     back to a hard reload so the login screen — not the still-mounted authed
 *     UI — is shown. persistWiped stays set until the next real re-login clears
 *     it via saveSession(), so nothing decryptable is written in between.
 */
export async function performWebIdleWipe(): Promise<void> {
  markDbWiped();
  await wipeWebSecureState();
  try {
    await resetLocalDb();
  } catch {
    /* best-effort — the token/snapshot/key are already gone */
  }
  const handler = getWebIdleLogoutHandler();
  if (handler) {
    try {
      await handler();
    } catch {
      /* best-effort */
    }
  } else if (typeof window !== 'undefined') {
    // No React handler registered — reload so index.tsx re-routes to login on a
    // fresh, empty DB (the snapshot + key are gone, so nothing is decryptable).
    try {
      window.location.reload();
    } catch {
      /* best-effort */
    }
  }
}

// ── Web idle auto-wipe ────────────────────────────────────────────────────────
// Native uses `useIdleLogout` (RN AppState + touch responder). The browser has
// no equivalent, so we install a document-level idle listener at module load
// (this module is imported early on web via the shared `../auth/session` path).
// After ~15 min of no interaction it runs performWebIdleWipe() above: a COMPLETE
// logout — wipe tokens/snapshot/key, close the in-memory DB, and flip the session
// to logged-out — so a walked-away session on a shared machine can't be resumed
// or read offline. Guarded to the browser inside installWebIdleWipe(); a no-op
// during SSR / tests.
//
// The immediate React redirect needs the app root to register its logout() via
// setWebIdleLogoutHandler() (see useWebIdleWipe.ts); until it does, step 4 above
// falls back to a hard reload, so the security wipe is complete either way.
installWebIdleWipe(() => { void performWebIdleWipe(); }, undefined, {
  // Same pre-wipe nudge the native app shows; any DOM interaction both re-arms
  // the timer (above) and clears a visible nudge (below).
  onWarn: () => {
    appAlertBus.alert({
      tag: IDLE_NUDGE_TAG,
      title: 'Still there?',
      message: "You'll be signed out in a minute due to inactivity.",
      buttons: [{ text: "I'm still here", style: 'cancel' }],
    });
  },
  onActivity: () => { appAlertBus.dismissActive(IDLE_NUDGE_TAG); },
});

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
    // Must mirror session.ts — without it a demo session on web looks like a
    // normal one: no sandbox, no wipe on logout, no 15-min idle cap.
    is_test: user.is_test ?? 0,
  };
}
