-- Migration 038: users.email — optional contact address for a user. SYNCED
-- (unlike enrollment_code_hash) so every device can display/edit it and the
-- admin "reset & email access code" flow can reach a stored recipient. Nullable;
-- no format enforcement at the DB layer.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
