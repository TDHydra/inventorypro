const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

export interface AuthResult {
  jwt: string;
  refreshToken: string;
  userId: string;
}

/**
 * Verify PIN against the API.
 * The API does the bcrypt compare server-side and returns a JWT on success.
 * On success the JWT + user data are stored locally for future offline use.
 *
 * PIN is verified server-side only (see verifyPin below); no hash is ever stored on device.
 */
export async function verifyPinOnline(userId: string, pin: string): Promise<AuthResult> {
  const res = await fetch(`${API_BASE}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, pin }),
  });

  if (res.status === 401) throw new Error('Incorrect PIN');
  if (res.status === 403) throw new Error('Account inactive or expired');
  if (!res.ok) throw new Error(`Auth error: ${res.status}`);

  return res.json() as Promise<AuthResult>;
}

/**
 * First-login PIN setup. The device confirms the PIN (double-entry) before
 * calling this; the server stores the hash, flips pin_set, and returns a session
 * exactly like /auth/token. Fails with 409 if a PIN was already set.
 *
 * `enrollmentCode` is the one-time code issued out-of-band when the account
 * was created; the server rejects the request with 401 if it doesn't match.
 */
export async function setPinFirstTime(userId: string, pin: string, enrollmentCode: string): Promise<AuthResult> {
  const res = await fetch(`${API_BASE}/auth/set-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, pin, enrollment_code: enrollmentCode }),
  });

  if (res.status === 401) throw new Error('Invalid enrollment code');
  if (res.status === 409) throw new Error('A PIN is already set for this account. Sign in with your PIN.');
  if (res.status === 403) throw new Error('Account inactive or expired');
  if (!res.ok) throw new Error(`Could not set PIN: ${res.status}`);

  return res.json() as Promise<AuthResult>;
}

// NOTE: PIN verification is intentionally online-only. The bcrypt hash is never
// stored on the device, so it cannot be extracted from a lost/stolen phone.
// Returning users unlock with biometrics (see auth/biometric + the unlock
// screen), which gates the device-held refresh token rather than re-checking
// the PIN locally.

export function validatePinFormat(pin: string, requiredLength: number): string | null {
  if (!/^\d+$/.test(pin)) return 'PIN must contain only digits';
  if (pin.length !== requiredLength) return `PIN must be exactly ${requiredLength} digits`;
  return null;
}

// Common/weak PINs to reject when a user CHOOSES a PIN (the set-PIN wizard).
// Straight sequences and single-digit repeats are handled algorithmically; this
// list only carries the non-obvious offenders. Mirrors apps/api/src/lib/weakPin.ts.
export const COMMON_PINS: readonly string[] = [
  '1212', '6969', '1004', '2000', '1122', '1313', '2001', '1010',
  '4040', '2580', '5150', '0852', '1379', '2468', '1357',
];

/**
 * True when `pin` is trivially guessable: a single repeated digit (0000,
 * 111111), a straight ascending/descending run (1234, 4321, 9876), or a member
 * of the common-PIN blocklist. Wrap-around runs (8901) are NOT sequences.
 *
 * IMPORTANT: only use this in the set-PIN wizard — never gate /auth/token login
 * with it, or existing users with a weak PIN can't sign in. Mirrors the server's
 * apps/api/src/lib/weakPin.ts so client and server agree.
 */
export function isWeakPin(pin: string): boolean {
  if (!/^\d+$/.test(pin)) return false;
  if (/^(\d)\1+$/.test(pin)) return true;
  const chars = pin.split('');
  const ascending = chars.every((d, i) => i === 0 || Number(d) === Number(pin[i - 1]) + 1);
  const descending = chars.every((d, i) => i === 0 || Number(d) === Number(pin[i - 1]) - 1);
  if (ascending || descending) return true;
  return COMMON_PINS.includes(pin);
}
