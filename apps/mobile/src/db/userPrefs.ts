import { getDb } from './schema';
import { appendOutbox } from '../sync/outbox';
import { getTheme, setThemeId } from '../themes/store';
import { resolveTheme } from '../themes/registry';
import { appAlertBus } from '../lib/alertBus';
import type { Layout, WidgetType } from '../dashboard/widgets';

/** Tag so repeated pulls can't stack duplicate theme prompts (bus dedupes). */
const THEME_SYNC_TAG = 'theme-sync';

/**
 * Per-user synced preferences (user_prefs, migration 040). One row per user;
 * the server forces user_id to the authenticated caller on push (attribution),
 * so a device can only ever write its own user's row.
 */

/** The user's synced theme id, or null if they never picked one. */
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
  // ON CONFLICT DO UPDATE (not INSERT OR REPLACE, migration 060 fix): REPLACE
  // deletes+reinserts the row, which would silently NULL out dashboard_prefs
  // on every theme change now that user_prefs carries a second column. This
  // upsert only ever touches theme/updated_at, same as the server's generic
  // push path (routes/sync.ts) only sets the columns present in the payload.
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
 * Personal dashboard customization (#193/#196, dashboard_prefs, migration 060).
 * A single JSON blob so one outbox write covers either edit:
 *   { layout?: LayoutBlock[], starred?: WidgetType[] }
 * `layout` is the user's personal override of the resolution chain — validated
 * by the caller (dashboard/store.ts resolveLayoutFor, via the same
 * parsePresetLayout a preset's raw layout column goes through). `starred` is
 * the set of WidgetType ids pinned to the dashboard's favorites strip.
 *
 * NOTE: dashboard/store.ts is the reactive cache for the hub — these helpers
 * are plain DB writes with no reactivity of their own (mirroring getUserTheme/
 * chooseTheme's split with themes/store.ts). Callers MUST call
 * loadDashboardCache() (from '../dashboard/store') after any of these writes
 * so useDashboardLayout()/useStarredWidgets() re-render without a remount —
 * the same "notify subscribers" call dashboards.tsx and roles.tsx already make
 * after their own preset/role-assignment edits. Importing dashboard/store here
 * directly would create a cycle (store.ts reads these prefs via
 * getDashboardPrefs below), so the UI layer owns that one extra call, same as
 * the two existing admin screens.
 */
export interface DashboardPrefs {
  layout?: Layout;
  starred?: WidgetType[];
}

/** The user's personal dashboard_prefs blob, or null if never set / invalid JSON. */
export function getDashboardPrefs(userId: string): DashboardPrefs | null {
  try {
    const rows = getDb().executeSync(
      `SELECT dashboard_prefs FROM user_prefs WHERE user_id = ?`, [userId]
    ).rows as { dashboard_prefs: string | null }[];
    const raw = rows.length ? rows[0].dashboard_prefs : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as DashboardPrefs) : null;
  } catch {
    return null;
  }
}

// ON CONFLICT DO UPDATE (not INSERT OR REPLACE — same theme-clobber trap fixed
// in chooseTheme above): only dashboard_prefs/updated_at are touched, so an
// existing theme is never wiped by a personal-layout or star edit, and the
// outbox payload mirrors that (server's generic push path likewise only sets
// the columns present in the payload — routes/sync.ts).
function writeDashboardPrefs(userId: string, prefs: DashboardPrefs): void {
  const updated_at = new Date().toISOString();
  const json = JSON.stringify(prefs);
  getDb().executeSync(
    `INSERT INTO user_prefs (user_id, dashboard_prefs, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET dashboard_prefs = excluded.dashboard_prefs, updated_at = excluded.updated_at`,
    [userId, json, updated_at]
  );
  appendOutbox('INSERT', 'user_prefs', { user_id: userId, dashboard_prefs: json, updated_at });
}

/**
 * Persist the user's personal layout override (#193), or clear it (pass null
 * or an empty array) to fall back to the user/role preset → role default →
 * DEFAULT_LAYOUT chain. Preserves any existing `starred` set.
 */
export function setDashboardLayout(userId: string, layout: Layout | null): void {
  const next: DashboardPrefs = { ...(getDashboardPrefs(userId) ?? {}) };
  if (layout && layout.length > 0) next.layout = layout;
  else delete next.layout;
  writeDashboardPrefs(userId, next);
}

/** Persist the user's starred-widget set (#196). Preserves any personal layout. */
export function setStarredWidgets(userId: string, starred: WidgetType[]): void {
  const next: DashboardPrefs = { ...(getDashboardPrefs(userId) ?? {}) };
  if (starred.length > 0) next.starred = starred;
  else delete next.starred;
  writeDashboardPrefs(userId, next);
}

/** Toggle one widget's starred membership and persist. Returns the new set. */
export function toggleStarredWidget(userId: string, widget: WidgetType): WidgetType[] {
  const current = getDashboardPrefs(userId)?.starred ?? [];
  const next = current.includes(widget) ? current.filter(w => w !== widget) : [...current, widget];
  setStarredWidgets(userId, next);
  return next;
}
