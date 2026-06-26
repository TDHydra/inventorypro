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
