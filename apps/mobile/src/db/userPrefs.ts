import { getDb } from './schema';
import { appendOutbox } from '../sync/outbox';
import { setThemeId } from '../themes/store';
import { resolveTheme } from '../themes/registry';

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
  getDb().executeSync(
    `INSERT OR REPLACE INTO user_prefs (user_id, theme, updated_at) VALUES (?, ?, ?)`,
    [userId, id, updated_at]
  );
  appendOutbox('INSERT', 'user_prefs', { user_id: userId, theme: id, updated_at });
  setThemeId(id);
}

/**
 * Apply the user's synced theme choice (login + after every pull). No-op when
 * they never picked one — the device keeps whatever theme_last / default it
 * already shows. setThemeId only notifies on an actual change, so calling this
 * every sync cycle is cheap.
 */
export function applyUserTheme(userId: string): void {
  const theme = getUserTheme(userId);
  if (theme) setThemeId(theme);
}
