// Weak/common-PIN rejection for FIRST-LOGIN PIN setup only (/auth/set-pin).
//
// CRITICAL: this is intentionally NOT applied at /auth/token. Users who already
// have a weak PIN must keep being able to sign in — retroactively enforcing this
// on the login path would lock them out of their own accounts. It only gates the
// moment a user chooses a new PIN.
//
// Mirrors the auth-lockout pattern in routes/auth.ts: a small, pure, unit-tested
// helper with an explicit, auditable blocklist.

// Frequently-chosen PINs from public breach-frequency analyses. Kept as an
// explicit, sorted-by-notoriety list so it is easy to audit and extend. Straight
// sequences and single-digit repeats are handled algorithmically below, so this
// list only needs the non-obvious offenders (repeated pairs, years, keypad
// shapes, etc.).
export const COMMON_PINS: readonly string[] = [
  '1212', '6969', '1004', '2000', '1122', '1313', '2001', '1010',
  '4040', '2580', '5150', '0852', '1379', '2468', '1357',
];

/**
 * True when `pin` is trivially guessable: a single repeated digit (0000,
 * 111111), a straight ascending/descending run (1234, 4321, 123456, 9876), or a
 * member of the common-PIN blocklist. Wrap-around runs (8901, 9012) are NOT
 * treated as sequences.
 *
 * Non-digit / empty input returns false — format is enforced separately by the
 * route schema and validatePinFormat, so this helper stays single-purpose.
 */
export function isWeakPin(pin: string): boolean {
  if (!/^\d+$/.test(pin)) return false;

  // All identical digits: 0000, 1111, 111111, ...
  if (/^(\d)\1+$/.test(pin)) return true;

  // Straight monotonic runs of consecutive digits, no wrap-around.
  const ascending = [...pin].every((d, i) => i === 0 || Number(d) === Number(pin[i - 1]) + 1);
  const descending = [...pin].every((d, i) => i === 0 || Number(d) === Number(pin[i - 1]) - 1);
  if (ascending || descending) return true;

  return COMMON_PINS.includes(pin);
}
