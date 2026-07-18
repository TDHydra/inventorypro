import { getDb } from './schema';
import { appendOutbox } from '../sync/outbox';
import { getTheme, setThemeId } from '../themes/store';
import { resolveTheme } from '../themes/registry';
import { appAlertBus } from '../lib/alertBus';

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
  getDb().executeSync(
    `INSERT OR REPLACE INTO user_prefs (user_id, theme, updated_at) VALUES (?, ?, ?)`,
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
