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
import { getUnitsDueForService } from '../db/queries/maintenance';
import { isTerminalStatus } from '../db/queries/taxonomy';
import { getSavedUserId, buildUserSession } from '../auth/session';
import { hasPermission } from '../auth/permissions';
import { isOverdueRepair } from '../dashboard/quickActions';
import { getOutboxCounts } from '../sync/outbox';
import { evaluateSyncStuckAlert, SYNC_STUCK_KEY } from './syncStuckAlert';
import { getQuietHours } from '../db/userPrefs';
import { isQuietHoursNow, utcMinutesNow } from './quietHours';

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
const SERVICE_DUE_PREFIX = 'alert:service_due:';

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
 * repairs + equipment service due). Called fire-and-forget after each sync
 * cycle. Pref-gated, permission-scoped, deduped via app_settings keys, and
 * wrapped so it can never throw into the sync loop.
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

    // #242: per-user quiet hours (user_prefs.quiet_hours_start/_end, UTC
    // minutes). Gates the four permission-scoped alerts below (low stock,
    // expiry, overdue repairs, service due) — NOT the sync-stuck alert
    // immediately below, which predates quiet hours and is about THIS
    // device's own unsynced work becoming un-syncable (arguably always
    // time-sensitive; left as-is per explicit decision, not silently changed
    // as a side effect of adding quiet hours). Dedup-key bookkeeping for the
    // gated alerts still runs regardless of inQuiet, so a suppressed alert
    // doesn't vanish forever nor double-fire the moment quiet hours end — it
    // simply resurfaces on the next natural sync cycle after the window
    // closes, same as every other dedup gate in this function.
    const quiet = getQuietHours(userId);
    const inQuiet = quiet ? isQuietHoursNow(quiet.start, quiet.end, utcMinutesNow()) : false;

    // ── Sync stuck (#205) ────────────────────────────────────────────────────
    // Not permission-scoped: the outbox is this device's own unsynced work.
    // Single aggregate alert (one dedup key, no per-entity suffix): fires when
    // the failed (attempts >= MAX, silently dropped from retry) bucket becomes
    // non-empty, clears when it drains so a later failure can re-fire. Runs
    // after each sync cycle, so the count is fresh. Tap deep-links via
    // data.screen 'sync' (push/handlers.ts) into the SyncIndicator sheet.
    const stuck = evaluateSyncStuckAlert(
      getOutboxCounts().failed,
      getAppSetting(SYNC_STUCK_KEY) !== null
    );
    if (stuck.action === 'notify') {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "Sync needs attention",
          body: stuck.body,
          data: { screen: 'sync' },
        },
        trigger: null,
      });
      setAppSetting(SYNC_STUCK_KEY, '1');
    } else if (stuck.action === 'clear') {
      deleteAppSetting(SYNC_STUCK_KEY);
    }

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
        // #242: while inQuiet, skip WITHOUT setting the dedup key — the key is
        // this alert's "already notified" marker, so leaving it unset means the
        // very next check (whether that's still mid-quiet-hours, harmlessly
        // re-skipped, or the first check after the window closes) still sees
        // this item as not-yet-notified and fires normally. Setting the key
        // while suppressed would make the alert vanish until the item recovers
        // and goes low again, which is not the intent.
        if (getAppSetting(key) === null && !inQuiet) {
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
        if (getAppSetting(key) === null && !inQuiet) {
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
    // getRepairs({done:false}) already excludes completed_at rows; the shared
    // isOverdueRepair predicate (#144 dashboard quick-action uses it too) also
    // checks isTerminalStatus as insurance against a stale/renamed status label.
    const canSeeRepairs = hasPermission(session, 'edit_inventory');
    const overdueRepairs = canSeeRepairs
      ? getRepairs({ done: false }).filter(r => isOverdueRepair(r, isTerminalStatus, Date.now()))
      : [];
    const overdueIds = overdueRepairs.map(r => r.id);
    if (canSeeRepairs) {
      for (const r of overdueRepairs) {
        const key = `${REPAIR_OVERDUE_PREFIX}${r.id}`;
        if (getAppSetting(key) === null && !inQuiet) {
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

    // ── Equipment service due ────────────────────────────────────────────────
    // Scoped like overdue repairs: edit_inventory is what gates maintenance
    // logging on the equipment screen. getUnitsDueForService only returns units
    // whose next_service_at is set and already past.
    const canSeeService = hasPermission(session, 'edit_inventory');
    const dueUnits = canSeeService ? getUnitsDueForService(new Date().toISOString()) : [];
    const dueIds = dueUnits.map(u => u.id);
    if (canSeeService) {
      for (const u of dueUnits) {
        const key = `${SERVICE_DUE_PREFIX}${u.id}`;
        if (getAppSetting(key) === null && !inQuiet) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Service due',
              body: `${u.asset_tag} was due ${new Date(u.next_service_at).toLocaleDateString()}`,
            },
            trigger: null,
          });
          setAppSetting(key, '1');
        }
      }
    }
    // Clear keys for units no longer due — serviced (next_service_at advanced or
    // cleared) or the permission was lost — so they can re-fire later.
    for (const key of getAppSettingKeysByPrefix(SERVICE_DUE_PREFIX)) {
      const id = key.slice(SERVICE_DUE_PREFIX.length);
      if (!dueIds.includes(id)) deleteAppSetting(key);
    }
  } catch (err) {
    console.warn('[Notifications] runLocalAlertChecks failed:', (err as Error).message);
  }
}
