import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  getAppSetting,
  setAppSetting,
  deleteAppSetting,
  getAppSettingKeysByPrefix,
} from '../db/appSettings';
import { getLowStockItems } from '../db/queries/items';
import { getExpiringUsers } from '../db/queries/users';
import { getRepairs } from '../db/queries/repairs';
import { isTerminalStatus } from '../db/queries/taxonomy';
import { getSavedUserId, buildUserSession } from '../auth/session';
import { hasPermission } from '../auth/permissions';

// ── Foreground handler (set once at module load) ─────────────────────────────
// Show an alert + play a sound when a notification arrives while the app is in
// the foreground (the default behaviour is to suppress it).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // shouldShowAlert is the SDK-56 deprecated alias; shouldShowBanner +
    // shouldShowList are the current required fields. Set all so the alert shows
    // regardless of which the runtime honours.
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const CHANNEL_ID = 'alerts';
const LOWSTOCK_PREFIX = 'alert:lowstock:';
const EXPIRY_PREFIX = 'alert:expiry:';
const REPAIR_OVERDUE_PREFIX = 'alert:repair_overdue:';

/**
 * Create the Android notification channel. Call once at app start. No-op on iOS
 * (channels are Android-only). Never throws.
 */
export async function initNotifications(): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Alerts',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
  } catch (err) {
    console.warn('[Notifications] initNotifications failed:', (err as Error).message);
  }
}

/**
 * Ensure OS notification permission. Checks current status; if undetermined,
 * prompts the user. Returns whether permission is granted. Never throws.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (current.status === Notifications.PermissionStatus.UNDETERMINED || current.canAskAgain) {
      const requested = await Notifications.requestPermissionsAsync();
      return requested.granted;
    }
    return false;
  } catch (err) {
    console.warn('[Notifications] ensureNotificationPermission failed:', (err as Error).message);
    return false;
  }
}

/**
 * Compute and fire local alerts (low stock + temp-employee expiry + overdue
 * repairs). Called fire-and-forget after each sync cycle. Pref-gated,
 * permission-scoped, deduped via app_settings keys, and wrapped so it can
 * never throw into the sync loop.
 */
export async function runLocalAlertChecks(): Promise<void> {
  try {
    // Pref gate — default ON when unset.
    if (getAppSetting('notifications_enabled') === 'false') return;

    // OS permission gate — do NOT prompt here (prompting happens at app start /
    // the settings toggle). Just read the current grant.
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return;

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
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Low stock',
              body: `${item.name} — ${item.total_stock} left`,
            },
            trigger: null,
          });
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
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Access expiring',
              body: `${u.name} on ${when}`,
            },
            trigger: null,
          });
          setAppSetting(key, '1');
        }
      }
    }
    // Clear keys for users no longer expiring (or all when not permitted).
    for (const key of getAppSettingKeysByPrefix(EXPIRY_PREFIX)) {
      const id = key.slice(EXPIRY_PREFIX.length);
      if (!expiringIds.includes(id)) deleteAppSetting(key);
    }

    // ── Overdue repairs ──────────────────────────────────────────────────────
    // Scoped like low stock: edit_inventory is the same permission that gates
    // status edits on the repair detail screen (see (repairs)/[id].tsx canEdit).
    // getRepairs({done:false}) already excludes completed_at rows; isTerminalStatus
    // is checked too as cheap insurance against a stale/renamed status label.
    const canSeeRepairs = hasPermission(session, 'edit_inventory');
    const overdueRepairs = canSeeRepairs
      ? getRepairs({ done: false }).filter(
          r => r.due_at != null && !isTerminalStatus(r.status) && new Date(r.due_at).getTime() < Date.now(),
        )
      : [];
    const overdueIds = overdueRepairs.map(r => r.id);
    if (canSeeRepairs) {
      for (const r of overdueRepairs) {
        const key = `${REPAIR_OVERDUE_PREFIX}${r.id}`;
        if (getAppSetting(key) === null) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Repair overdue',
              body: `${r.entity_label ?? 'Repair'} was due ${new Date(r.due_at as string).toLocaleDateString()}`,
            },
            trigger: null,
          });
          setAppSetting(key, '1');
        }
      }
    }
    // Clear keys for repairs no longer overdue — completed/reopened past terminal,
    // due_at cleared, or the permission was lost — so they can re-fire later.
    for (const key of getAppSettingKeysByPrefix(REPAIR_OVERDUE_PREFIX)) {
      const id = key.slice(REPAIR_OVERDUE_PREFIX.length);
      if (!overdueIds.includes(id)) deleteAppSetting(key);
    }
  } catch (err) {
    console.warn('[Notifications] runLocalAlertChecks failed:', (err as Error).message);
  }
}
