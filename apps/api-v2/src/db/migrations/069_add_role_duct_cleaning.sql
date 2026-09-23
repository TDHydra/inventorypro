-- Migration 069: new role — duct_cleaning_technician (Eddie).
-- Adds the enum value ONLY. Prod PG version assumed >= 12, so `ALTER TYPE ...
-- ADD VALUE` running inside migrate.ts's per-file BEGIN/COMMIT transaction is
-- safe here (the new value is not USED by any statement in this same
-- transaction/file). The value is consumed by 070 (role_settings seed row),
-- which MUST live in a separate migration file: a new enum value cannot be
-- used in the same transaction that adds it (migrate.ts wraps each file in
-- its own transaction, one file per commit).
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'duct_cleaning_technician';
