// #235: pure classification of a /sync/push conflict as PERMANENT (retrying
// can never make it succeed — an authorization/validation denial the server
// will keep refusing) or TRANSIENT (a network/data hiccup, bounded retry via
// MAX_ATTEMPTS). Split out of engine.ts — which imports react-native/expo
// modules and can't load under plain `node:test` — same pattern denialMessages.ts
// already uses for testable pure logic.
//
// `code` mirrors apps/api/src/routes/sync.ts's SyncRejectionCode: FORBIDDEN
// (a specific permission check failed), NOT_ALLOWED (the table/operation is
// never permitted via sync, regardless of caller), VALIDATION (malformed or
// guarded payload data) are permanent; MAINTENANCE (freeze lifts eventually)
// and CONFLICT (everything else, incl. transient DB-lookup failures) are not.

const PERMANENT_CODES = new Set(['FORBIDDEN', 'NOT_ALLOWED', 'VALIDATION']);

// Legacy fallback for servers that predate the `code` field, and for any
// unrecognized/future code value this build doesn't know about — an
// unrecognized code must not silently start dropping entries a newer server
// meant to keep transient, so it falls through to the same wording heuristic
// as "no code at all" rather than defaulting to permanent.
// Deliberately conservative: only these three phrases classify as permanent,
// so an unrecognized rejection defaults to retry-then-dead-letter behavior.
const PERMANENT_REJECTION_TEXT = /forbidden|cannot|not allowed/i;

export function isPermanentRejection(error?: string, code?: string): boolean {
  if (code) {
    if (PERMANENT_CODES.has(code)) return true;
    if (code === 'MAINTENANCE' || code === 'CONFLICT') return false;
    // Unrecognized code — fall through to the wording heuristic below.
  }
  return !!error && PERMANENT_REJECTION_TEXT.test(error);
}
