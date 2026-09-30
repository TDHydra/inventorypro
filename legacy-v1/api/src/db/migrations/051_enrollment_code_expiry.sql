-- Expiry for the one-time enrollment code (bug #45). Codes minted by
-- issueEnrollmentCode (routes/users.ts) previously never expired, so /auth/set-pin
-- (routes/auth.ts) would honour a leaked or long-forgotten code forever. This
-- column stamps a hard window (issuers set NOW() + INTERVAL '7 days'); set-pin
-- treats NULL or a past timestamp as "no active code" and refuses.
ALTER TABLE users ADD COLUMN IF NOT EXISTS enrollment_code_expires_at TIMESTAMPTZ;

-- Backfill pre-existing rows that already carry an unconsumed enrollment_code_hash
-- (minted before this migration, hence expires_at IS NULL). Give them a fresh
-- 7-day window from now so a user mid-enrollment at deploy time isn't locked out.
-- Rows with a NULL hash have no active code and stay NULL (treated as "expired").
UPDATE users
   SET enrollment_code_expires_at = NOW() + INTERVAL '7 days'
 WHERE enrollment_code_hash IS NOT NULL
   AND enrollment_code_expires_at IS NULL;
