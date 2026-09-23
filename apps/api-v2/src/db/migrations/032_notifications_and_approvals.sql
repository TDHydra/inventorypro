-- Synced notifications inbox + approvals workflow (Notifications Platform #3/#4/#5).
-- Both tables ARE synced (registered in ALLOWED_TABLES/FULL_TABLES/pull.ts).
--   notifications      — per-user inbox rows; pull is SCOPED to user_id; clients
--                        may only write read_at (see syncPolicy SENSITIVE_DENY).
--   approval_requests  — org-wide two-way review flags; INSERT/UPDATE by authed
--                        users, DELETE denied; requester_id forced to the caller.
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT,
  read_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY,
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'manual',
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  decided_by UUID,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  entity_type TEXT,
  entity_id UUID,
  metadata TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests (status, updated_at DESC);
