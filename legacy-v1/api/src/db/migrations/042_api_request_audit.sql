-- Server-only API access/audit trail: who called what, when, from where, and
-- whether it succeeded, was denied, or errored.
--
-- NOT synced to devices. This table must stay absent from routes/sync.ts
-- (ALLOWED_TABLES / FULL_TABLES / CONFLICT_TARGETS), lib/syncPolicy.ts,
-- mobile sync/pull.ts, and BOTH mobile schema.ts and schema.web.ts migration
-- arrays. It holds cross-user PII (ip, device, user-agent); replicating it to
-- every device would hand every user the whole org's access log. Read it over
-- REST via GET /audit (view_audit_log), never through sync. Modeled on
-- telemetry_events (029), which is server-only for the same reason.
--
-- Secrets are excluded STRUCTURALLY, not by filtering: the writing hook
-- (lib/audit.ts) never reads request.body or the Authorization header, so PINs,
-- pin_hash, enrollment codes, JWTs and refresh tokens cannot land here. Do not
-- add a body/header column.
CREATE TABLE IF NOT EXISTS api_request_audit (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Correlation id, echoed to the client as X-Request-Id. Ties this HTTP
  -- request to any activity_log rows it produced (metadata->>'request_id').
  request_id     UUID NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Actor. user_id goes NULL when the user is deleted, so actor_name/actor_role
  -- are denormalized SNAPSHOTS taken at write time — an audit row must keep
  -- naming its actor after that user is gone.
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name     TEXT,
  actor_role     TEXT,

  method         TEXT NOT NULL,
  -- Route TEMPLATE (e.g. /users/:id) for grouping; `path` is the concrete path
  -- with the query string stripped (query strings can carry caller-supplied data).
  route          TEXT NOT NULL,
  path           TEXT NOT NULL,

  status_code    INTEGER NOT NULL,
  -- success | denied | rate_limited | client_error | server_error.
  -- 429 is its own outcome: brute-force throttling must not look like a typo.
  outcome        TEXT NOT NULL,
  duration_ms    INTEGER,

  -- Where. Best-effort: populated from trusted X-Forwarded-For (see trustProxy)
  -- and the X-Telemetry-* headers the mobile client attaches.
  ip             TEXT,
  user_agent     TEXT,
  device_id      TEXT,
  platform       TEXT,
  app_version    TEXT,

  -- Sanitized class-level reason for 4xx/5xx. NEVER a stack trace, SQL text, or
  -- driver detail (see index.ts setErrorHandler: 5xx internals are not leaked).
  error_message  TEXT,

  -- Auth failures, privileged-mutation denials, 5xx, and role/permission/user
  -- changes. Retained on a longer window than routine traffic.
  security_class BOOLEAN NOT NULL DEFAULT FALSE
);

-- Keyset pagination (occurred_at, id) — never OFFSET on an append-heavy table.
CREATE INDEX IF NOT EXISTS api_audit_keyset_idx    ON api_request_audit(occurred_at DESC, id DESC);
-- Composite, to serve the filtered-and-sorted admin queries.
CREATE INDEX IF NOT EXISTS api_audit_user_idx      ON api_request_audit(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS api_audit_outcome_idx   ON api_request_audit(outcome, occurred_at DESC);
CREATE INDEX IF NOT EXISTS api_audit_route_idx     ON api_request_audit(method, route, occurred_at DESC);
CREATE INDEX IF NOT EXISTS api_audit_request_idx   ON api_request_audit(request_id);
CREATE INDEX IF NOT EXISTS api_audit_security_idx  ON api_request_audit(occurred_at DESC) WHERE security_class;
