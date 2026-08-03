import { getDb, rowsAs } from './schema';
import { appendOutbox } from '../sync/outbox';
import { runInTransaction } from './tx';
import { getTheme, setThemeId } from '../themes/store';
import { resolveTheme } from '../themes/registry';
import { appAlertBus } from '../lib/alertBus';
import type { Layout, LayoutBlock, WidgetType } from '../dashboard/widgets';

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
 * Personal dashboard customization (#193/#196; dashboard_layout/starred_widgets,
 * migration 062). Each field is its OWN synced column — split out of the
 * original single dashboard_prefs JSON blob (migration 060) because a blob
 * multiplexing both fields forced every setter to read-merge-write the WHOLE
 * column: a device whose local replica was stale (hadn't pulled the other
 * device's edit yet) would silently clobber it (Device B saving a layout
 * erased Device A's already-synced stars, since B's read of the blob predated
 * A's write). Per-column writes below only ever touch ONE column, so the
 * existing column-scoped server upsert (ON CONFLICT DO UPDATE SET <only the
 * columns present in the payload> — routes/sync.ts) protects each field
 * independently, same as it already does for theme.
 *
 * `layout` is the user's personal override of the resolution chain — validated
 * by the caller (dashboard/store.ts resolveLayoutFor, via the same
 * parsePresetLayout a preset's raw layout column goes through). `starred` is
 * the set of WidgetType ids pinned to the dashboard's favorites strip.
 *
 * getDashboardPrefs() keeps its old {layout?, starred?} composed shape (so
 * dashboard/store.ts's two call sites are unchanged) but now reads from the
 * two columns, falling back per-field to the legacy dashboard_prefs blob only
 * when a column is NULL (a row pulled before this device ran migration 062 —
 * ordinary rows get backfilled by the migration itself).
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
  // #226: plain WidgetType keys OR composite `widget:source` star keys
  // (dashboard/starKeys.ts) — stored/validated as opaque strings here.
  starred?: string[];
}

interface DashboardPrefsRow {
  dashboard_layout: string | null;
  starred_widgets: string | null;
  dashboard_prefs: string | null;
}

/** Parse the legacy single-blob column — used only as a per-field fallback. */
function parseLegacyBlob(raw: string | null): DashboardPrefs | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as DashboardPrefs) : null;
  } catch {
    return null;
  }
}

/** Parse one of the split JSON-array columns; null/invalid/empty -> undefined. */
function parseArrayField<T>(raw: string | null): T[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as T[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The user's personal dashboard customization, composed from the split
 * columns (falling back to the legacy blob per-field for a not-yet-backfilled
 * row), or null if the user has never customized either field.
 */
export function getDashboardPrefs(userId: string): DashboardPrefs | null {
  try {
    const rows = rowsAs<DashboardPrefsRow>(getDb().executeSync(
      `SELECT dashboard_layout, starred_widgets, dashboard_prefs FROM user_prefs WHERE user_id = ?`,
      [userId]
    ).rows);
    if (!rows.length) return null;
    const row = rows[0];
    const legacy = row.dashboard_layout == null || row.starred_widgets == null
      ? parseLegacyBlob(row.dashboard_prefs) : null;

    const result: DashboardPrefs = {};
    const layout = row.dashboard_layout != null ? parseArrayField<LayoutBlock>(row.dashboard_layout) : legacy?.layout;
    if (layout) result.layout = layout;
    const starred = row.starred_widgets != null ? parseArrayField<string>(row.starred_widgets) : legacy?.starred;
    if (starred) result.starred = starred;
    return (result.layout || result.starred) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Persist the user's personal layout override (#193), or clear it (pass null
 * or an empty array) to fall back to the user/role preset → role default →
 * DEFAULT_LAYOUT chain. Writes ONLY dashboard_layout — starred_widgets (and
 * theme) are untouched locally AND in the outbox payload, so a stale local
 * replica can never clobber another device's already-synced stars (#193/#196
 * regression this migration fixes).
 */
export function setDashboardLayout(userId: string, layout: Layout | null): void {
  const updated_at = new Date().toISOString();
  // '[]', never NULL (#240): to getDashboardPrefs, NULL means "not yet
  // backfilled from the legacy blob" and falls back to dashboard_prefs — so a
  // NULL-clearing reset was silently undone by the old blob layout on every
  // render. '[]' parses to "explicitly cleared" (parseArrayField -> undefined)
  // with no fallback, while genuinely un-migrated rows keep their NULL.
  const json = layout && layout.length > 0 ? JSON.stringify(layout) : '[]';
  runInTransaction(() => {
    getDb().executeSync(
      `INSERT INTO user_prefs (user_id, dashboard_layout, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET dashboard_layout = excluded.dashboard_layout, updated_at = excluded.updated_at`,
      [userId, json, updated_at]
    );
    appendOutbox('INSERT', 'user_prefs', { user_id: userId, dashboard_layout: json, updated_at });
  });
}

/**
 * Persist the user's starred-widget set (#196). Writes ONLY starred_widgets —
 * dashboard_layout (and theme) are untouched locally AND in the outbox
 * payload, mirroring setDashboardLayout above.
 */
export function setStarredWidgets(userId: string, starred: string[]): void {
  const updated_at = new Date().toISOString();
  // '[]', never NULL — same #240 legacy-blob-fallback trap as setDashboardLayout.
  const json = starred.length > 0 ? JSON.stringify(starred) : '[]';
  runInTransaction(() => {
    getDb().executeSync(
      `INSERT INTO user_prefs (user_id, starred_widgets, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET starred_widgets = excluded.starred_widgets, updated_at = excluded.updated_at`,
      [userId, json, updated_at]
    );
    appendOutbox('INSERT', 'user_prefs', { user_id: userId, starred_widgets: json, updated_at });
  });
}

/** Toggle one star key's membership and persist. Returns the new set. */
export function toggleStarredWidget(userId: string, key: string): string[] {
  const current = getDashboardPrefs(userId)?.starred ?? [];
  const next = current.includes(key) ? current.filter(w => w !== key) : [...current, key];
  setStarredWidgets(userId, next);
  return next;
}

/**
 * Per-user quiet hours (#242, migration 064). Stored as UTC-minutes-since-
 * midnight (0-1439); NULL/NULL means disabled. See
 * apps/mobile/src/notifications/quietHours.ts for the shared window-math
 * (isQuietHoursNow) this feeds, and settings.tsx's save site for the
 * DST/travel-drift tradeoff of computing UTC minutes client-side.
 */
export interface QuietHours {
  start: number;
  end: number;
}

interface QuietHoursRow {
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
}

/** The user's synced quiet-hours window, or null if never set / disabled. */
export function getQuietHours(userId: string): QuietHours | null {
  try {
    const rows = rowsAs<QuietHoursRow>(getDb().executeSync(
      `SELECT quiet_hours_start, quiet_hours_end FROM user_prefs WHERE user_id = ?`, [userId]
    ).rows);
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
 * INSERT OR REPLACE) — a stale replica on one device can never clobber
 * another device's theme/dashboard/quiet-hours edit or vice versa.
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
