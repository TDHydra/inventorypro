// user_prefs — per-user synced preferences. Phase 2 carried only the theme
// column; Station D3 added quiet hours (#242) + per-category notification
// prefs (#245) for the settings split. Deliberately NOT ported: dashboard
// layout/stars (v2 dashboards are hardcoded per role — plan decision) and the
// onboarding checklist (login flow kept lean; revisit at the parity gate).
import { appendOutbox, runInTransaction } from '@invenpro/core';
import { getTheme, setThemeId, resolveTheme } from '@invenpro/ui';
import { appAlertBus } from '@invenpro/ui';
import { getDb } from './schema';

const THEME_SYNC_TAG = 'theme-sync';

export function getUserTheme(userId: string): string | null {
  try {
    const rows = getDb().executeSync(
      `SELECT theme FROM user_prefs WHERE user_id = ?`, [userId]
    ).rows as { theme: string | null }[];
    return rows.length ? rows[0].theme : null;
  } catch {
    return null;
  }
}

/**
 * User picked a theme: apply it now, persist locally, and sync it to their
 * other devices. The store also caches it in app_settings ('theme_last') so
 * the next cold boot / pre-login screens render it immediately.
 */
export function chooseTheme(userId: string, themeId: string): void {
  const id = resolveTheme(themeId).id;
  const updated_at = new Date().toISOString();
  // ON CONFLICT DO UPDATE (not INSERT OR REPLACE): REPLACE deletes+reinserts
  // the row, which would silently NULL every OTHER user_prefs column on a
  // theme change. This upsert only ever touches theme/updated_at, same as the
  // server's column-scoped push path.
  getDb().executeSync(
    `INSERT INTO user_prefs (user_id, theme, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, updated_at = excluded.updated_at`,
    [userId, id, updated_at]
  );
  appendOutbox('INSERT', 'user_prefs', { user_id: userId, theme: id, updated_at });
  setThemeId(id);
}

/**
 * Apply the user's synced theme choice. No-op when they never picked one —
 * the device keeps whatever theme_last / default it already shows.
 *
 * `prompt` (the post-pull path): a theme that differs from what this device
 * is showing means it was changed on ANOTHER device — ask before re-skinning
 * mid-use. "Keep current" writes this device's theme back to user_prefs, so
 * declining also reverts the originating device (a real cancel, not a local
 * ignore that the next pull would re-prompt). Login and same-device changes
 * stay silent: chooseTheme() already applied locally, so synced == active.
 */
export function applyUserTheme(userId: string, opts: { prompt?: boolean } = {}): void {
  const synced = getUserTheme(userId);
  if (!synced) return;
  const incoming = resolveTheme(synced);
  const active = getTheme();
  if (!opts.prompt || incoming.id === active.id) {
    setThemeId(incoming.id);
    return;
  }
  appAlertBus.alert({
    tag: THEME_SYNC_TAG,
    title: 'Theme changed',
    message: `Your theme was switched to "${incoming.name}" on another device. Apply it here too?`,
    buttons: [
      { text: 'Keep current', style: 'cancel', onPress: () => chooseTheme(userId, active.id) },
      { text: 'Apply', onPress: () => setThemeId(incoming.id) },
    ],
  });
}

/**
 * Per-user quiet hours (#242). Stored as UTC-minutes-since-midnight (0-1439);
 * NULL/NULL means disabled. src/notifications/quietHours.ts owns the shared
 * window math (isQuietHoursNow); the settings save site computes UTC minutes
 * client-side (device offset baked in — the documented DST/travel tradeoff).
 */
export interface QuietHours {
  start: number;
  end: number;
}

/** The user's synced quiet-hours window, or null if never set / disabled. */
export function getQuietHours(userId: string): QuietHours | null {
  try {
    const rows = getDb().executeSync(
      `SELECT quiet_hours_start, quiet_hours_end FROM user_prefs WHERE user_id = ?`, [userId]
    ).rows as { quiet_hours_start: number | null; quiet_hours_end: number | null }[];
    if (!rows.length) return null;
    const { quiet_hours_start, quiet_hours_end } = rows[0];
    if (quiet_hours_start == null || quiet_hours_end == null) return null;
    return { start: quiet_hours_start, end: quiet_hours_end };
  } catch {
    return null;
  }
}

/**
 * Persist the user's quiet-hours window (both UTC-minutes-since-midnight), or
 * clear it (pass null for both) to disable. Writes ONLY the two quiet_hours
 * columns + updated_at (column-scoped upsert, mig-060 postmortem — never
 * INSERT OR REPLACE), same discipline as chooseTheme above.
 */
export function setQuietHours(userId: string, start: number | null, end: number | null): void {
  const updated_at = new Date().toISOString();
  runInTransaction(() => {
    getDb().executeSync(
      `INSERT INTO user_prefs (user_id, quiet_hours_start, quiet_hours_end, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET quiet_hours_start = excluded.quiet_hours_start, quiet_hours_end = excluded.quiet_hours_end, updated_at = excluded.updated_at`,
      [userId, start, end, updated_at]
    );
    appendOutbox('INSERT', 'user_prefs', { user_id: userId, quiet_hours_start: start, quiet_hours_end: end, updated_at });
  });
}

/**
 * Self-service "My Notifications" (#245). notification_prefs is a single JSON
 * blob { category: boolean } multiplexing all 7 categories — a deliberate
 * trade-off (personal settings, single-user edits, low collision
 * probability), not a repeat of the 060 dashboard_prefs anti-pattern.
 * Missing key OR missing row = enabled (opt-out model). Server-side
 * enforcement (push suppression only, inbox always lands) is filterMuted()
 * in apps/api/src/lib/notifications.ts.
 *
 * Scope: only the 7 categories that route through deliver()/sendPush server-
 * side. low_stock and server_errors are deliberately NOT here — inventory-
 * health pings an individual shouldn't be able to silence alone. The client-
 * local alerts engine (src/notifications/localAlerts.ts) is a different
 * subsystem, gated by the device-level toggle in settings.
 */
export const NOTIFICATION_CATEGORIES = [
  'assignment', 'chat', 'schedule', 'approvals', 'on_call', 'checkout_idle', 'broadcast',
] as const;
export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number];

/** Parsed { category: enabled } map. A missing/malformed row is `{}` (every category enabled). */
export function getNotificationPrefs(userId: string): Record<string, boolean> {
  try {
    const rows = getDb().executeSync(
      `SELECT notification_prefs FROM user_prefs WHERE user_id = ?`, [userId]
    ).rows as { notification_prefs: string | null }[];
    if (!rows.length || !rows[0].notification_prefs) return {};
    const parsed: unknown = JSON.parse(rows[0].notification_prefs);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * Toggle one category's mute state and persist. Writes ONLY notification_prefs
 * + updated_at (column-scoped upsert, mig-060 postmortem — never INSERT OR
 * REPLACE), same discipline as setQuietHours.
 */
export function setNotificationCategoryPref(userId: string, category: NotificationCategory, enabled: boolean): void {
  const current = getNotificationPrefs(userId);
  const next = { ...current, [category]: enabled };
  const json = JSON.stringify(next);
  const updated_at = new Date().toISOString();
  runInTransaction(() => {
    getDb().executeSync(
      `INSERT INTO user_prefs (user_id, notification_prefs, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET notification_prefs = excluded.notification_prefs, updated_at = excluded.updated_at`,
      [userId, json, updated_at]
    );
    appendOutbox('INSERT', 'user_prefs', { user_id: userId, notification_prefs: json, updated_at });
  });
}
