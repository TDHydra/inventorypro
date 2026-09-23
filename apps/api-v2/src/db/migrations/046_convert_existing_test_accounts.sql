-- Make the EXISTING "Test *" accounts the public demo accounts (user decision,
-- 2026-07-13). Migration 045 seeded a fresh set, which collided by name with the
-- real Test accounts already in the roster — two "Test Admin" rows, only one of
-- them enrollable. The real ones win; the pure duplicates are retired.
--
-- Converting an account to is_test means: sandboxed on device, rejected by every
-- server write path, and enrollable by anyone with the publicly displayed code.
-- So the PIN must be cleared (pin_hash NULL → the roster's pin_set is FALSE →
-- the enrollment wizard runs, and /auth/set-pin's is_test branch never persists
-- one). Anyone currently signed in as one of these keeps their 15m token but
-- can no longer write; their next sign-in goes through the demo code.
UPDATE users SET
  is_test = TRUE,
  pin_hash = NULL,
  pin_set = FALSE,
  enrollment_code_hash = NULL,
  enrollment_code_public = v.code,
  updated_at = NOW()   -- seed-watermark: enrolled devices pick these up on the next incremental pull
FROM (VALUES
  ('5d75ab04-76dd-4cbb-9e62-f771d9153cb2'::uuid, '111111'),  -- Test Admin (full_admin)
  ('01aa16ad-e9ea-495c-8866-6aef1955a83e'::uuid, '333333'),  -- Test Construction Manager (head_of_construction)
  ('90bf8fad-0064-4f96-bcba-391d40abfa45'::uuid, '666666'),  -- Test Contents Manager (hr_manager)
  ('552b5aa8-6d7a-4f11-b002-b2a7d8e3aab6'::uuid, '777777'),  -- Test FrMan (franchise_manager)
  ('1bb4dc3b-566d-4476-a5a7-3955ddbd7505'::uuid, '888888'),  -- Test HR (hr_manager)
  ('7d6c0f1f-b90f-400e-9acb-f9332ae2ef38'::uuid, '999999')   -- Test OM (hr_manager)
) AS v(id, code)
WHERE users.id = v.id;

-- Retire the two 045 seeds that merely duplicate a real account's name+role.
-- Deactivated, not deleted: user rows are referenced by activity_log (whose
-- prod rules forbid DELETE), and active = FALSE already drops them from the
-- roster, which is all the login screen reads.
UPDATE users SET active = FALSE, updated_at = NOW()
WHERE id IN (
  'e5710001-0000-4000-8000-000000000001',  -- seeded "Test Admin" → real one converted above
  'e5710001-0000-4000-8000-000000000003'   -- seeded "Test Construction Manager" → ditto
);

-- The other three 045 seeds STAY: they cover roles the real Test accounts don't
-- have — office_manager (the real "Test OM" is actually role hr_manager),
-- mitigation_technician, and temporary_employee (the most restrictive sets, and
-- the most useful to demo).
