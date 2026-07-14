-- Migration 049: message edit/delete markers (#29 Step C). Mirrors mobile
-- migration 039. edited_at marks a sender-edited message; deleted_at marks a
-- soft-deleted one (the sync push handler blanks the body when deleted_at is
-- set — deleted messages never retain content). Nullable: NULL = untouched.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
