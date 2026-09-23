-- One-time enrollment code (bcrypt hash) required to set a first PIN. Issued when
-- an admin creates the user; cleared once the PIN is set. Server-only, never synced.
ALTER TABLE users ADD COLUMN IF NOT EXISTS enrollment_code_hash TEXT;
