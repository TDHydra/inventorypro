import { UserRole, ROLE_TIER } from '../constants/roles';
import { getAppConfig, setAppConfigLocal } from './appConfig';
import { appendOutbox } from '../sync/outbox';

const MAINTENANCE_KEY = 'maintenance_mode';

/** Thrown by the write-layer guard when a non-exempt user writes during maintenance. */
export class MaintenanceLockedError extends Error {
  constructor() {
    super('System is under maintenance (read-only).');
    this.name = 'MaintenanceLockedError';
  }
}

// Cached: is the current user tier-4 (exempt from the lockout)? Defaults to
// false so nothing is wrongly exempted before a session resolves.
let exemptRole = false;

/** Wire the current user's role so the guard knows whether they're exempt. */
export function setMaintenanceRole(role: UserRole | null): void {
  exemptRole = role != null && ROLE_TIER[role] === 4;
}

/** Is app-wide maintenance currently ON? */
export function isMaintenanceActive(): boolean {
  return getAppConfig(MAINTENANCE_KEY) === '1';
}

/** Should the current user's writes be blocked right now? */
export function isWriteBlocked(): boolean {
  return isMaintenanceActive() && !exemptRole;
}

/** Hard guard — throws when writes are blocked. Called from appendOutbox. */
export function assertWritable(): void {
  if (isWriteBlocked()) throw new MaintenanceLockedError();
}

/**
 * Admin action: set maintenance ON/OFF. Writes locally AND pushes through the
 * outbox so it syncs to every device. Admins are exempt, so this is never
 * blocked — they can flip it both on and off.
 */
export function setMaintenanceMode(on: boolean): void {
  const value = on ? '1' : '0';
  setAppConfigLocal(MAINTENANCE_KEY, value);
  // 'INSERT' is the outbox's full-row upsert op; the server applies it as
  // INSERT ... ON CONFLICT (key) DO UPDATE (CONFLICT_TARGETS['app_config']='key'
  // from Task 1), so re-toggling updates value + updated_at in place.
  appendOutbox('INSERT', 'app_config', {
    key: MAINTENANCE_KEY,
    value,
    updated_at: new Date().toISOString(),
  });
}
