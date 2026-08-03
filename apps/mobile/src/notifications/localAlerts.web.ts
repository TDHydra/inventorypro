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
import { getRepairs } from '../db/queries/repairs';
import { getUnitsDueForService } from '../db/queries/maintenance';
import { isTerminalStatus } from '../db/queries/taxonomy';
import { getSavedUserId, buildUserSession } from '../auth/session';
import { hasPermission } from '../auth/permissions';
import { isOverdueRepair } from '../dashboard/quickActions';
import { getOutboxCounts } from '../sync/outbox';
import { evaluateSyncStuckAlert, SYNC_STUCK_KEY } from './syncStuckAlert';
import { listNotifications } from '../db/queries/notifications';
import { evaluateInboxAlerts, INBOX_SEEN_KEY } from './inboxAlerts';
import { getQuietHours } from '../db/userPrefs';
import { isQuietHoursNow, utcMinutesNow } from './quietHours';

const LOWSTOCK_PREFIX = 'alert:lowstock:';
const EXPIRY_PREFIX = 'alert:expiry:';
const REPAIR_OVERDUE_PREFIX = 'alert:repair_overdue:';
const SERVICE_DUE_PREFIX = 'alert:service_due:';

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
    if (!permissionGranted()) return;

    // Resolve the current session user + permissions.
    const userId = await getSavedUserId();
    if (!userId) return;
    const session = buildUserSession(userId);
    if (!session) return;

    // #242: per-user quiet hours — same gate as the native twin (localAlerts.ts).
    // Covers low stock/expiry/overdue-repairs/service-due only, not sync-stuck
    // or the inbox parity alert (#232) above/below.
    const quiet = getQuietHours(userId);
    const inQuiet = quiet ? isQuietHoursNow(quiet.start, quiet.end, utcMinutesNow()) : false;

    // ── Sync stuck (#205) ────────────────────────────────────────────────────
    // Not permission-scoped: the outbox is this device's own unsynced work.
    // Single aggregate alert — fires when the failed (retry-exhausted) bucket
    // becomes non-empty, clears when it drains so a later failure can re-fire.
    // No tap deep-link on web (browser Notification carries no data payload
    // handler here); the alert itself is the parity that matters.
    const stuck = evaluateSyncStuckAlert(
      getOutboxCounts().failed,
      getAppSetting(SYNC_STUCK_KEY) !== null
    );
    if (stuck.action === 'notify') {
      notify('Sync needs attention', stuck.body ?? '');
      setAppSetting(SYNC_STUCK_KEY, '1');
    } else if (stuck.action === 'clear') {
      deleteAppSetting(SYNC_STUCK_KEY);
    }

    // ── Server inbox (#232) ──────────────────────────────────────────────────
    // Native devices get these as Expo push; on web the synced inbox would land
    // silently. Surface rows that arrived since the last check (watermarked, so
    // a first run / fresh enrollment seeds silently instead of blasting
    // history; rows read on another device never fire).
    const inbox = evaluateInboxAlerts(
      listNotifications(50),
      getAppSetting(INBOX_SEEN_KEY),
    );
    for (const n of inbox.toNotify) notify(n.title, n.body);
    if (inbox.nextWatermark !== null) setAppSetting(INBOX_SEEN_KEY, inbox.nextWatermark);

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
        if (getAppSetting(key) === null && !inQuiet) {
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
        if (getAppSetting(key) === null && !inQuiet) {
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
          notify('Repair overdue', `${r.entity_label ?? 'Repair'} was due ${new Date(r.due_at as string).toLocaleDateString()}`);
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
          notify('Service due', `${u.asset_tag} was due ${new Date(u.next_service_at).toLocaleDateString()}`);
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
