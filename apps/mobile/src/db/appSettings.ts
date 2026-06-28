import { getDb } from './schema';

/**
 * Reads the idle-timeout setting from `app_settings`.
 * Returns the value as an integer number of minutes, or `0` if unset / invalid.
 */
export function getIdleTimeoutMinutes(): number {
  try {
    const rows = getDb().executeSync(
      `SELECT value FROM app_settings WHERE key = 'idle_timeout_minutes'`
    ).rows as { value: string }[];
    if (!rows.length) return 0;
    const parsed = parseInt(rows[0].value, 10);
    return isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
}

/**
 * Persists the idle-timeout setting to `app_settings`.
 * @param mins Number of minutes (0 = disabled).
 */
export function setIdleTimeoutMinutes(mins: number): void {
  getDb().executeSync(
    `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('idle_timeout_minutes', ?)`,
    [String(mins)]
  );
}

/** Reads any app_settings value, or null if unset. */
export function getAppSetting(key: string): string | null {
  try {
    const rows = getDb().executeSync(`SELECT value FROM app_settings WHERE key = ?`, [key]).rows as { value: string }[];
    return rows.length ? rows[0].value : null;
  } catch {
    return null;
  }
}
/** Writes any app_settings value. */
export function setAppSetting(key: string, value: string): void {
  getDb().executeSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`, [key, value]);
}

/** Deletes an app_settings row by key (no-op if it doesn't exist). */
export function deleteAppSetting(key: string): void {
  getDb().executeSync(`DELETE FROM app_settings WHERE key = ?`, [key]);
}

/** Returns every app_settings key starting with `prefix` (empty array on error). */
export function getAppSettingKeysByPrefix(prefix: string): string[] {
  try {
    const rows = getDb().executeSync(
      `SELECT key FROM app_settings WHERE key LIKE ?`,
      [`${prefix}%`]
    ).rows as { key: string }[];
    return rows.map(r => r.key);
  } catch {
    return [];
  }
}
