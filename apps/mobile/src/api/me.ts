// Authed self-service /me endpoints (role-dashboards spec §5). All calls are
// online-only: the server is authoritative and updates users.updated_at so the
// change propagates to every device via the normal sync pull. Callers mirror
// the confirmed value into the LOCAL users row (updateUserLocal, no outbox —
// the server already has it) so this device reflects it immediately.
//
// PIN change lives with its siblings in src/auth/pin.ts (changePinOnline).

import { getValidJwt } from '../auth/session';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

async function authedRequest(path: string, method: string, body: unknown): Promise<Response> {
  const jwt = await getValidJwt();
  if (!jwt) throw new Error('Connect to the server to update your profile.');
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
}

// Surfaces the server's `{ error }` reason when present (validation detail),
// else a generic status-tagged message.
async function throwApiError(res: Response, fallback: string): Promise<never> {
  let serverMsg: string | null = null;
  try {
    serverMsg = ((await res.json()) as { error?: string }).error ?? null;
  } catch { /* non-JSON body */ }
  throw new Error(serverMsg ?? `${fallback} (${res.status}).`);
}

/**
 * Step 1 of an email change: POST /me/email/request-code. The server stores the
 * pending change and emails a 6-digit code to the NEW address. `{sent:false}`
 * means SMTP isn't configured — the pending row still exists (code_hash null)
 * and the caller falls back to the type-twice confirm flow (confirm without a
 * code).
 */
export async function requestEmailChangeCode(email: string): Promise<{ sent: boolean }> {
  const res = await authedRequest('/me/email/request-code', 'POST', { email });
  if (!res.ok) return throwApiError(res, 'Could not start the email change');
  return (await res.json()) as { sent: boolean };
}

/**
 * Step 2: POST /me/email/confirm. With `code` when one was emailed; without it
 * only for the SMTP-unavailable fallback (server accepts codeless confirm just
 * when the pending row's code_hash is null). 204 on success — the server sets
 * users.email and bumps updated_at.
 */
export async function confirmEmailChange(email: string, code?: string): Promise<void> {
  const res = await authedRequest('/me/email/confirm', 'POST', code ? { email, code } : { email });
  if (!res.ok) return throwApiError(res, 'Could not confirm the email change');
}

/**
 * PATCH /me/phone with an already-NORMALIZED value from validatePhone (or null
 * to clear). The server re-validates/normalizes and bumps updated_at. 204.
 * (PATCH, not PUT: the API's write wall and CORS allowlist cover
 * POST/PATCH/DELETE only.)
 */
export async function updatePhoneOnline(phone: string | null): Promise<void> {
  const res = await authedRequest('/me/phone', 'PATCH', { phone });
  if (!res.ok) return throwApiError(res, 'Could not update your phone number');
}
