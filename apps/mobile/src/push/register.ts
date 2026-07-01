import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { getDb } from '../db/schema';
import { getValidJwt } from '../auth/session';
import { getAppConfig } from '../db/appConfig';
import { generateUUID } from '../utils/uuid';

// Push registration is best-effort everywhere in this module: it must never
// block login, app-foreground, or logout. Every exported function swallows
// its own errors.
const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

const PUSH_TOKEN_KEY = 'push_token';
const DEVICE_ID_KEY = 'push_device_id';

function getSetting(key: string): string | null {
  try {
    const rows = getDb().executeSync(`SELECT value FROM app_settings WHERE key = ?`, [key]).rows as { value: string }[];
    return rows.length ? rows[0].value : null;
  } catch {
    return null;
  }
}

function setSetting(key: string, value: string): void {
  getDb().executeSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`, [key, value]);
}

function clearSetting(key: string): void {
  getDb().executeSync(`DELETE FROM app_settings WHERE key = ?`, [key]);
}

// Stable per-install id, generated once and persisted locally (not synced).
function getOrCreateDeviceId(): string {
  const existing = getSetting(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = generateUUID();
  setSetting(DEVICE_ID_KEY, id);
  return id;
}

// Push is opt-out via either an env-level kill switch (build-time) or the
// synced app_config kill switch (runtime, admin-controlled). Unset app_config
// defaults to enabled — only an explicit '0' disables.
function pushDisabled(): boolean {
  if (process.env.EXPO_PUBLIC_PUSH === '0') return true;
  if (getAppConfig('push_enabled') === '0') return true;
  return false;
}

/**
 * Requests notification permission and registers the resulting Expo push
 * token with the server. Best-effort: any failure (permission denied, offline,
 * no session, kill-switch) is swallowed — this must never block login or the
 * caller's flow. No-op if the token hasn't changed since the last successful
 * registration.
 */
export async function registerForPush(): Promise<void> {
  if (pushDisabled()) return;
  try {
    const jwt = await getValidJwt();
    if (!jwt) return;

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted) {
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.granted;
    }
    if (!granted) return;

    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
    if (!token) return;

    const lastRegistered = getSetting(PUSH_TOKEN_KEY);
    const deviceId = getOrCreateDeviceId();
    if (token === lastRegistered) return; // already registered, avoid needless traffic

    const res = await fetch(`${API_BASE}/push/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ expo_push_token: token, platform: Platform.OS, device_id: deviceId }),
    });
    if (res.ok) setSetting(PUSH_TOKEN_KEY, token);
  } catch {
    /* best-effort — never block the caller */
  }
}

/**
 * Unregisters this device's push token from the server and clears the local
 * record. Best-effort — safe to call even if nothing was ever registered.
 */
export async function unregisterPush(): Promise<void> {
  try {
    const token = getSetting(PUSH_TOKEN_KEY);
    if (!token) return;
    const jwt = await getValidJwt();
    if (jwt) {
      await fetch(`${API_BASE}/push/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ expo_push_token: token }),
      });
    }
    clearSetting(PUSH_TOKEN_KEY);
  } catch {
    /* best-effort */
  }
}
