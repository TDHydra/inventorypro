import { getDb } from './schema';

/** app_config key for the org-wide default theme (Phase E, #138). */
export const ORG_THEME_KEY = 'default_theme_id';

/** Reads a synced app_config value, or null if unset. */
export function getAppConfig(key: string): string | null {
  try {
    const rows = getDb().executeSync(
      `SELECT value FROM app_config WHERE key = ?`,
      [key],
    ).rows as { value: string }[];
    return rows.length ? rows[0].value : null;
  } catch {
    return null;
  }
}

/** Writes a synced app_config value LOCALLY (does not push — see setMaintenanceMode). */
export function setAppConfigLocal(key: string, value: string): void {
  getDb().executeSync(
    `INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)`,
    [key, value, new Date().toISOString()],
  );
}
