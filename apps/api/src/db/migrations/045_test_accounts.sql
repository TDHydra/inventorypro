-- Public test/demo accounts: anyone can enroll from the login screen with a
-- publicly displayed access code and explore what each role's permissions allow.
--
-- is_test marks the account server-side (enforcement is ALWAYS this flag, never
-- name matching): /sync/push rejects every write from a test caller, the global
-- mutating-route hook 403s them, and /auth/set-pin verifies against
-- enrollment_code_public WITHOUT persisting a pin (pin_set stays FALSE, the code
-- is never cleared) so the account self-resets for the next visitor.
--
-- enrollment_code_public is plaintext BY DESIGN — it is shown in gray under the
-- login fields. It is only ever populated on is_test rows, only projected to
-- clients through `CASE WHEN is_test` (roster + sync USERS_COLS), and both new
-- columns sit in the sync deny-lists so no client write path can set them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS enrollment_code_public TEXT;

-- Five demo accounts spanning the permission spectrum, fixed UUIDs so re-runs
-- are idempotent. pin_hash stays NULL forever (roster derives pin_set from it).
INSERT INTO users (id, name, role, pin_length_required, active, pin_set, is_test, enrollment_code_public)
VALUES
  ('e5710001-0000-4000-8000-000000000001', 'Test Admin',                'full_admin',            4, TRUE, FALSE, TRUE, '111111'),
  ('e5710001-0000-4000-8000-000000000002', 'Test Office Manager',       'office_manager',        4, TRUE, FALSE, TRUE, '222222'),
  ('e5710001-0000-4000-8000-000000000003', 'Test Construction Manager', 'head_of_construction',  4, TRUE, FALSE, TRUE, '333333'),
  ('e5710001-0000-4000-8000-000000000004', 'Test Technician',           'mitigation_technician', 4, TRUE, FALSE, TRUE, '444444'),
  ('e5710001-0000-4000-8000-000000000005', 'Test Temp',                 'temporary_employee',    4, TRUE, FALSE, TRUE, '555555')
ON CONFLICT (id) DO NOTHING;
