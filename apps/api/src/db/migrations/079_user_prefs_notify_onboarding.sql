-- Migration 079: two more self-service user_prefs columns (#245/#246). Mirrors
-- mobile migration 065. Both are genuinely NULL-for-everyone-until-written —
-- no backfill, no watermark touch needed.
--
-- notification_prefs TEXT — JSON map { category: boolean } (#245, "My
-- Notifications"). Missing key or missing row = enabled (opt-out model).
-- Never a PG enum/array — plain TEXT, per house rule.
--
-- onboarding_checklist TEXT — JSON { status: 'pending' | 'dismissed' } (#246,
-- first-login checklist). Only mobile's login.tsx submitSetPin success branch
-- ever writes 'pending'; NULL means "never show" for every pre-existing row.
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS notification_prefs TEXT;
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS onboarding_checklist TEXT;
