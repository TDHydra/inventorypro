// Pure client-side validation for the Change PIN sheet (role-dashboards spec
// §4). Reuses the enrollment rules — validatePinFormat with the user's
// pin_length_required, isWeakPin — plus the two change-specific rules the
// server also enforces (different-from-current, matching confirmation) so the
// user gets instant per-field feedback before any network call. The server
// re-validates everything; this is UX, not security.

import { validatePinFormat, isWeakPin } from '../../auth/pin';

export interface PinChangeErrors {
  current?: string;
  next?: string;
  confirm?: string;
}

/** Empty object = valid; otherwise one message per offending field. */
export function validatePinChange(
  current: string,
  next: string,
  confirm: string,
  requiredLength: number,
): PinChangeErrors {
  const errors: PinChangeErrors = {};

  const currentFmt = validatePinFormat(current, requiredLength);
  if (currentFmt) errors.current = current ? currentFmt : 'Enter your current PIN.';

  const nextFmt = validatePinFormat(next, requiredLength);
  if (nextFmt) {
    errors.next = next ? nextFmt : 'Enter a new PIN.';
  } else if (isWeakPin(next)) {
    errors.next = 'That PIN is too easy to guess. Avoid repeats, sequences, and common PINs.';
  } else if (next === current) {
    errors.next = 'New PIN must be different from your current PIN.';
  }

  if (!errors.next && next !== confirm) {
    errors.confirm = confirm ? 'PINs don’t match.' : 'Re-enter your new PIN to confirm.';
  }

  return errors;
}
