// user_prefs — per-user synced preferences. Phase 2 carries only the theme
// column; dashboard layout/stars and the onboarding checklist return with
// their surfaces (Waves B/D).
import { appendOutbox } from '@invenpro/core';
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
