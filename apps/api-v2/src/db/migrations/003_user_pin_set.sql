-- Migration 003: self-service first-login PIN
-- Users can now be created without a PIN; they set (and confirm) their own on
-- first sign-in. `pin_set` tracks whether that has happened.

ALTER TABLE users ALTER COLUMN pin_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_set BOOLEAN NOT NULL DEFAULT FALSE;

-- Anyone who already has a real hash is considered set. Bump updated_at so the
-- change propagates to devices on the next incremental pull.
UPDATE users
   SET pin_set = TRUE, updated_at = NOW()
 WHERE pin_hash IS NOT NULL AND pin_hash <> '';
