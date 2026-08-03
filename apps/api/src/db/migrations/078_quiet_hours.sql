-- Migration 078: per-user quiet hours (#242). Mirrors mobile migration 064.
-- quiet_hours_start/_end are UTC-minutes-since-midnight (0-1439), computed by
-- the MOBILE CLIENT at save time from local wall-clock + the device's
-- current UTC offset — there is no timezone column anywhere in this schema,
-- so this is a deliberate correctness tradeoff: a user who travels or crosses
-- a DST boundary keeps the OLD offset baked into their saved window until
-- they resave the setting on their device (see apps/mobile settings.tsx save
-- site + apps/mobile/src/notifications/quietHours.ts / lib/quietHours.ts for
-- the shared window-math this feeds). NULL/NULL = disabled (the "never set"
-- convention theme/dashboard_layout already use).
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS quiet_hours_start INTEGER;
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS quiet_hours_end INTEGER;
