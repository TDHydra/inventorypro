import type { FastifyRequest } from 'fastify';

// API access/audit trail capture. See migration 042.
//
// SECURITY INVARIANT — do not weaken:
// Nothing in this file may read `request.body` or the `Authorization` /
// `Cookie` headers. Secrets (PINs, enrollment codes, JWTs, refresh tokens) live
// exclusively in those two places, so never touching them keeps them out of the
// audit table structurally. That is a stronger guarantee than scrubbing a
// denylist of field names, which silently fails the moment someone adds a new
// secret-bearing field. audit.test.ts enforces this.

export type Outcome = 'success' | 'denied' | 'rate_limited' | 'client_error' | 'server_error' | 'validation_reject';

// Routine, high-volume endpoints that would otherwise bury the signal. Every
// offline-first device polls /sync/pull continuously and flushes /telemetry in
// batches, so these dominate the table by orders of magnitude.
//
// Matched regardless of METHOD: POST /telemetry is behavioral ingest with its
// own sink, not a business mutation, and skipping it only for GET would let
// every telemetry flush write an audit row. Only *successful* requests are
// skipped — a failure here is still a failure. Debug mode captures them anyway.
//
// POST /sync/push is deliberately absent: it is the app's entire write surface
// and is always audited.
const NOISY_PREFIXES = [
  '/health',
  '/telemetry',   // fire-and-forget behavioral ingest; has its own sink
  '/labels',      // QR png renders
  '/audit',       // the audit tab reading itself
  '/sync/pull',
  '/sync/full',
];

// Debug mode captures EVERY request, including the noisy polls above. Off by
// default; flip it on while chasing a sync bug. Seeded from AUDIT_DEBUG so a
// container can boot verbose, and togglable at runtime (PATCH /audit/debug)
// so turning it on does not require a redeploy. Intentionally in-memory: a
// verbose mode that survives a restart is a footgun.
let debugMode = /^(1|true|yes)$/i.test(process.env.AUDIT_DEBUG ?? '');

export function isAuditDebug(): boolean {
  return debugMode;
}

export function setAuditDebug(on: boolean): boolean {
  debugMode = on;
  return debugMode;
}

// Retention windows (days). Security-class rows outlive routine traffic.
export const AUDIT_RETAIN_DAYS = parseInt(process.env.AUDIT_RETAIN_DAYS ?? '30', 10);
export const AUDIT_RETAIN_SECURITY_DAYS = parseInt(process.env.AUDIT_RETAIN_SECURITY_DAYS ?? '365', 10);

// `validationReject` is stashed by the global error handler when Fastify's
// schema validation rejected the request (err.validation) — a malformed-input
// probe is distinguishable from an ordinary client error without ever reading
// the offending body.
export function outcomeFor(statusCode: number, validationReject = false): Outcome {
  if (statusCode >= 500) return 'server_error';
  if (statusCode === 429) return 'rate_limited';       // brute force ≠ validation typo
  if (validationReject && statusCode >= 400) return 'validation_reject';
  if (statusCode === 401 || statusCode === 403) return 'denied';
  if (statusCode >= 400) return 'client_error';
  return 'success';
}

// Rows worth keeping long-term: anything that failed, plus successful changes to
// who-can-do-what. These answer "was there an intrusion", not "was there traffic".
export function isSecurityClass(method: string, url: string, outcome: Outcome): boolean {
  if (outcome === 'denied' || outcome === 'rate_limited' || outcome === 'server_error') return true;
  // Schema-invalid input is probe-shaped traffic — retained like other failures.
  if (outcome === 'validation_reject') return true;
  if (url.startsWith('/auth')) return true;            // logins, set-pin, refresh — success or not
  if (method === 'GET') return false;
  // Toggling the demo-account kill switch changes who can sign in.
  if (url.startsWith('/audit/demo-mode')) return true;
  return /^\/(users|teams)\b/.test(url);               // role/permission/membership changes
}

// A request is captured when debug mode is on, OR it changes state, OR it
// failed, OR it touched /auth. Routine successful reads of the noisy endpoints
// are dropped. Everything else (successful GET /items, /jobs, …) is captured:
// knowing who read what is part of the ask.
export function shouldAudit(method: string, url: string, outcome: Outcome): boolean {
  if (debugMode) return true;
  if (outcome !== 'success') return true;              // never drop a failure
  // Order matters: this must precede any "never drop a mutation" shortcut, or
  // POST /telemetry (a batched flush, not a business write) slips through and
  // every device's telemetry flush writes an audit row.
  const path = stripQuery(url);
  if (NOISY_PREFIXES.some(p => path === p || path.startsWith(`${p}/`))) return false;
  return true;
}

// Strip the query string: it is caller-supplied and may carry data we have no
// business persisting.
export function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function headerStr(request: FastifyRequest, name: string): string | null {
  const v = request.headers[name];
  if (typeof v === 'string') return v.slice(0, 512);
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].slice(0, 512);
  return null;
}

export interface AuditRow {
  request_id: string;
  user_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  method: string;
  route: string;
  path: string;
  status_code: number;
  outcome: Outcome;
  duration_ms: number | null;
  ip: string | null;
  user_agent: string | null;
  device_id: string | null;
  platform: string | null;
  app_version: string | null;
  error_message: string | null;
  security_class: boolean;
}

// Build the row from the request/reply. Reads ONLY: method, url, routeOptions,
// status, timing, ip, and the user-agent / X-Telemetry-* headers.
export function buildAuditRow(
  request: FastifyRequest,
  statusCode: number,
  durationMs: number,
  actor: { id: string | null; name: string | null; role: string | null },
  errorMessage: string | null,
  validationReject = false,
): AuditRow {
  const method = request.method;
  const path = stripQuery(request.url);
  const outcome = outcomeFor(statusCode, validationReject);
  return {
    request_id: String(request.id),
    user_id: actor.id,
    actor_name: actor.name,
    actor_role: actor.role,
    method,
    // The matched template (/users/:id) when Fastify resolved one; the concrete
    // path otherwise (404s never match a route).
    route: request.routeOptions?.url ?? path,
    path,
    status_code: statusCode,
    outcome,
    duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    ip: request.ip ?? null,
    user_agent: headerStr(request, 'user-agent'),
    device_id: headerStr(request, 'x-telemetry-device'),
    platform: headerStr(request, 'x-telemetry-platform'),
    app_version: headerStr(request, 'x-telemetry-appver'),
    error_message: errorMessage ? errorMessage.slice(0, 300) : null,
    security_class: isSecurityClass(method, path, outcome),
  };
}

// 4xx messages from /auth can echo submitted field context back out of Fastify's
// validation errors. Store only the class, never the message, for those routes.
export function sanitizeErrorMessage(url: string, statusCode: number, message: string | undefined): string | null {
  if (!message) return null;
  if (statusCode >= 500) return null;                  // internals never leak (see index.ts)
  if (stripQuery(url).startsWith('/auth')) return null;
  return message;
}
