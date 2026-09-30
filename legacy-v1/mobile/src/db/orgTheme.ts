import { getAppConfig, setAppConfigLocal, ORG_THEME_KEY } from './appConfig';
import { getUserTheme } from './userPrefs';
import { appendOutbox } from '../sync/outbox';
import { setThemeId } from '../themes/store';
import { resolveTheme } from '../themes/registry';

/**
 * Org-wide default theme (app_config 'default_theme_id', synced). Precedence:
 * user_prefs.theme -> this -> DEFAULT_THEME_ID. Same admin write path as
 * setMaintenanceMode (local upsert + outbox INSERT; server upserts on key and
 * gates the push behind PRIVILEGED_TABLE_PERM app_config -> system_settings).
 */

/** The org default theme id, or null when the admin never set one. */
export function getOrgDefaultThemeId(): string | null {
  return getAppConfig(ORG_THEME_KEY);
}

/**
 * Re-theme THIS device to the org default — unless `userId` chose their own
 * theme (user_prefs wins). `null` = pre-login (sign-in screen / fresh install),
 * which always applies. persist:false keeps app_settings 'theme_last' a
 * personal-choice cache only; boot falls back to app_config itself.
 */
export function applyOrgDefaultTheme(userId: string | null): void {
  if (userId && getUserTheme(userId)) return;
  const id = getOrgDefaultThemeId();
  if (!id) return;
  setThemeId(resolveTheme(id).id, { persist: false });
}

/** Admin action: set the org default, sync it everywhere, apply it here. */
export function setOrgDefaultTheme(themeId: string, currentUserId: string | null): void {
  const id = resolveTheme(themeId).id;
  setAppConfigLocal(ORG_THEME_KEY, id);
  appendOutbox('INSERT', 'app_config', {
    key: ORG_THEME_KEY,
    value: id,
    updated_at: new Date().toISOString(),
  });
  applyOrgDefaultTheme(currentUserId);
}
