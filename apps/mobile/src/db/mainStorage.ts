import { getAppConfig, setAppConfigLocal } from './appConfig';
import { appendOutbox } from '../sync/outbox';

// App-wide "main storage area": the location new stock defaults to (e.g. Quick
// Add's current-stock destination). Stored in app_config and synced to every
// device — identical pattern to setFormModeDefault / setMaintenanceMode.
const KEY = 'main_storage_location_id';

/** The admin-set main storage location id, or null when unset/cleared. */
export function getMainStorageLocationId(): string | null {
  const v = getAppConfig(KEY);
  return v && v.trim() ? v : null;
}

/**
 * Admin action: set (or clear, with null) the app-wide main storage area.
 * Writes locally AND pushes through the outbox so it syncs to every device.
 * Clearing stores '' (the unset sentinel), which getMainStorageLocationId reads
 * back as null.
 */
export function setMainStorageLocation(locationId: string | null): void {
  const value = locationId ?? '';
  setAppConfigLocal(KEY, value);
  appendOutbox('INSERT', 'app_config', {
    key: KEY,
    value,
    updated_at: new Date().toISOString(),
  });
}
