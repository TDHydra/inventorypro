import { UserRole, ROLE_TIER } from '../constants/roles';
import { getAppConfig, setAppConfigLocal } from './appConfig';
import { appendOutbox } from '../sync/outbox';

const MAINTENANCE_KEY = 'maintenance_mode';

/** Thrown by the write-layer guard when a non-exempt user writes during
 * maintenance, OR when a session preview (#199) is active. `message` lets
 * callers tell the two lockouts apart without a second error type — every
 * existing call site that catches this by class/name keeps working unchanged. */
export class MaintenanceLockedError extends Error {
  constructor(message = 'System is under maintenance (read-only).') {
    super(message);
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

// #199: session preview-as-role. While previewing, ALL writes are blocked —
// unconditionally, regardless of the real user's role/maintenance-exemption —
// because a preview must never let the real identity mutate data "as" a
// pretend role. Wired by the session provider (app/_layout.tsx) whenever
// previewRole changes; false by default so nothing outside a preview is
// affected. Kept as its own flag (not folded into exemptRole/maintenance
// state) so the two lockouts stay independently reasoned-about and can carry
// distinct messages.
let previewWriteBlockActive = false;

/** Session preview (#199): mark whether writes should be centrally blocked
 * because a role preview is active. */
export function setPreviewWriteBlock(active: boolean): void {
  previewWriteBlockActive = active;
}

/** Is a session preview currently forcing read-only, independent of maintenance? */
export function isPreviewWriteBlocked(): boolean {
  return previewWriteBlockActive;
}

/** Should the current user's writes be blocked right now? Central point every
 * write path (and every screen's own pre-flight check) reads. */
export function isWriteBlocked(): boolean {
  return previewWriteBlockActive || (isMaintenanceActive() && !exemptRole);
}

/** Hard guard — throws when writes are blocked. Called from appendOutbox. */
export function assertWritable(): void {
  if (previewWriteBlockActive) throw new MaintenanceLockedError('Preview mode is read-only.');
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
