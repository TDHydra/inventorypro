// Web shim for ../notifications/localAlerts (native uses expo-notifications).
// Backed by the browser Web Notifications API. Exports the SAME symbols with
// identical signatures so shared call sites work unchanged on web. Never throws
// at import time and degrades gracefully when Notification is unavailable or
// permission is denied (all checks become no-ops).
import {
  getAppSetting,
  setAppSetting,
  deleteAppSetting,
  getAppSettingKeysByPrefix,
} from '../db/appSettings';
import { getLowStockItems } from '../db/queries/items';
import { getExpiringUsers } from '../db/queries/users';
import { getSavedUserId, buildUserSession } from '../auth/session';
import { hasPermission } from '../auth/permissions';

const LOWSTOCK_PREFIX = 'alert:lowstock:';
const EXPIRY_PREFIX = 'alert:expiry:';

// True only when the browser exposes the Notifications API.
function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

// Whether the OS/browser has currently granted notification permission.
function permissionGranted(): boolean {
  return notificationsSupported() && Notification.permission === 'granted';
}

// Fire a local notification. Best-effort: swallows any failure (e.g. user has
// dismissed permission since, or the page is not a secure context).
function notify(title: string, body: string): void {
  try {
    if (!permissionGranted()) return;
    // eslint-disable-next-line no-new
    new Notification(title, { body });
  } catch {
    /* ignore — never throw into the caller */
  }
}

/**
 * No-op on web. (Android channels have no browser analogue.) Never throws.
 * Kept for API parity with the native module.
 */
export async function initNotifications(): Promise<void> {
  // Nothing to set up for the Web Notifications API.
  return;
}

/**
 * Ensure browser notification permission. Checks current status; if
 * undetermined ('default'), prompts the user. Returns whether permission is
 * granted. Returns false (no-op) when unsupported or denied. Never throws.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (!notificationsSupported()) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch (err) {
    console.warn('[Notifications] ensureNotificationPermission failed:', (err as Error).message);
    return false;
  }
}

/**
 * Compute and fire local alerts (low stock + temp-employee expiry). Called
 * fire-and-forget after each sync cycle. Pref-gated, permission-scoped, deduped
 * via app_settings keys, and wrapped so it can never throw into the sync loop.
 */
export async function runLocalAlertChecks(): Promise<void> {
  try {
    // Pref gate — default ON when unset.
    if (getAppSetting('notifications_enabled') === 'false') return;

    // OS permission gate — do NOT prompt here (prompting happens at app start /
    // the settings toggle). Just read the current grant.
    if (!permissionGranted()) return;

    // Resolve the current session user + permissions.
    const userId = await getSavedUserId();
    if (!userId) return;
    const session = buildUserSession(userId);
    if (!session) return;

    // ── Low stock ────────────────────────────────────────────────────────────
    // Only fire if the user may see inventory; but always reconcile the dedup
    // keys against the "currently low" set (empty when not permitted), so losing
    // the permission mid-session prunes stale keys rather than orphaning them.
    const canSeeStock = hasPermission(session, 'edit_inventory');
    const lowItems = canSeeStock ? getLowStockItems() : [];
    const lowIds = lowItems.map(i => i.id);
    if (canSeeStock) {
      for (const item of lowItems) {
        const key = `${LOWSTOCK_PREFIX}${item.id}`;
        if (getAppSetting(key) === null) {
          notify('Low stock', `${item.name} — ${item.total_stock} left`);
          setAppSetting(key, '1');
        }
      }
    }
    // Clear keys for items that have recovered (or all keys when not permitted),
    // so they can re-fire later.
    for (const key of getAppSettingKeysByPrefix(LOWSTOCK_PREFIX)) {
      const id = key.slice(LOWSTOCK_PREFIX.length);
      if (!lowIds.includes(id)) deleteAppSetting(key);
    }

    // ── Temp-employee expiry ──────────────────────────────────────────────────
    const canManageUsers = hasPermission(session, 'manage_users');
    const expiring = canManageUsers ? getExpiringUsers(7) : [];
    const expiringIds = expiring.map(u => u.id);
    if (canManageUsers) {
      for (const u of expiring) {
        const key = `${EXPIRY_PREFIX}${u.id}`;
        if (getAppSetting(key) === null) {
          const when = u.expires_at
            ? new Date(u.expires_at).toLocaleDateString()
            : '';
          notify('Access expiring', `${u.name} on ${when}`);
          setAppSetting(key, '1');
        }
      }
    }
    // Clear keys for users no longer expiring (or all when not permitted).
    for (const key of getAppSettingKeysByPrefix(EXPIRY_PREFIX)) {
      const id = key.slice(EXPIRY_PREFIX.length);
      if (!expiringIds.includes(id)) deleteAppSetting(key);
    }
  } catch (err) {
    console.warn('[Notifications] runLocalAlertChecks failed:', (err as Error).message);
  }
}
