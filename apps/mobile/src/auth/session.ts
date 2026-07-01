import * as SecureStore from 'expo-secure-store';
import { UserSession, parsePermissionOverrides } from './permissions';
import { getUserById } from '../db/queries/users';

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
    if (!res.ok) return jwt;                            // refresh rejected — keep existing
    const data = await res.json() as { jwt: string };
    await SecureStore.setItemAsync(JWT_KEY, data.jwt);
    return data.jwt;
  } catch {
    return jwt;                                         // offline — keep existing
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
  };
}
