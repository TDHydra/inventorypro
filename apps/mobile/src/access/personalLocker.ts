import {
  findOrCreateLockerForUser, retireLocker, getStockAtLocation, getLocationsByOwner,
  type Location,
} from '../db/queries/locations';
import { grantUnitAccessWithDefaults } from './unitGrants';

// "Personal locker" toggle (#146 — follow-up to #130, where users' lockers had
// been created as untyped sub-areas and were invisible to the Lockers UI).
// Flipping ON finds-or-creates the user's OWNED type='Locker' location
// (reactivating a retired one rather than duplicating) and applies their role's
// unit_access defaults; flipping OFF retires it (active=FALSE — locations are
// never hard-deleted) but REFUSES while the locker still holds stock, returning
// a reason the UI can show. Callers must be session-gated on manage_locations —
// /sync/push rejects the locations write otherwise.

export type PersonalLockerResult =
  | { ok: true; lockerId: string | null }
  | { ok: false; reason: string };

/** The user's ACTIVE owned Locker, or null — backs the toggle's on/off state. */
export function getPersonalLocker(userId: string): Location | null {
  return getLocationsByOwner(userId).find(l => l.type === 'Locker') ?? null;
}

/**
 * Turn the personal locker ON. Already-active locker → returned as-is WITHOUT
 * re-applying defaults (an admin's later per-action tweaks must survive a
 * redundant toggle). Create/reactivate → the role's unit_access defaults are
 * granted via grantUnitAccessWithDefaults (grant failure is non-fatal: the
 * locker exists and access can be granted from the permissions sheet).
 */
export function enablePersonalLocker(
  userId: string, userName: string, role: string, actorUserId: string | null,
): PersonalLockerResult {
  const existing = getPersonalLocker(userId);
  if (existing) return { ok: true, lockerId: existing.id };
  const lockerId = findOrCreateLockerForUser(userId, userName);
  if (!lockerId) return { ok: false, reason: 'Could not create the locker. Please try again.' };
  try {
    grantUnitAccessWithDefaults(lockerId, userId, role, actorUserId);
  } catch (err) {
    console.warn('enablePersonalLocker: locker created but default grant failed', err);
  }
  return { ok: true, lockerId };
}

/**
 * Turn the personal locker OFF (retire, never delete). No active locker →
 * no-op success (lockerId null). Stock still in the locker → refusal with a
 * user-facing reason; move/remove the stock first.
 */
export function disablePersonalLocker(userId: string): PersonalLockerResult {
  const locker = getPersonalLocker(userId);
  if (!locker) return { ok: true, lockerId: null };
  const stock = getStockAtLocation(locker.id);
  if (stock.length > 0) {
    const n = stock.length;
    return {
      ok: false,
      reason: `${locker.name} still holds stock (${n} item${n === 1 ? '' : 's'}). Move or remove it first, then turn the locker off.`,
    };
  }
  if (!retireLocker(locker.id)) {
    return { ok: false, reason: 'Could not retire the locker. Please try again.' };
  }
  return { ok: true, lockerId: locker.id };
}
