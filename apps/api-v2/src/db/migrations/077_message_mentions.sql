-- Migration 077: chat @mentions (#241). Mirrors mobile migration 063, and the
-- media.audience_user_ids precedent (064): mentioned_user_ids is a JSON array
-- of user UUIDs (TEXT), NULL when the message has no @mentions. TEXT
-- deliberately — never a PG enum on a synced column (unit_category remap
-- incident).
--
-- Mentioned participants bypass their per-conversation notify_pref (mute
-- included) — see lib/push.ts's messageRecipients() mentionedUserIds param.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentioned_user_ids TEXT;
