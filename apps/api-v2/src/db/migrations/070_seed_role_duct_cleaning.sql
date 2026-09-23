-- Migration 070: role_settings seed row for duct_cleaning_technician (Eddie),
-- tier 1 (crew) — see 001_initial_schema.sql:35-48 for the original seed
-- pattern. Split from 069 on purpose: the enum value it references is only
-- safe to USE once 069 has committed (see 069's header comment).
INSERT INTO role_settings (role, min_pin_length) VALUES
  ('duct_cleaning_technician', 4)
ON CONFLICT (role) DO NOTHING;
