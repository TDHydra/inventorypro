-- demo_mode is the apex-only kill switch for the public demo accounts: when it
-- reads '0' the demo/test accounts are hidden and unenrollable. A MISSING row
-- means ON ('1') — clients and the server must treat absence as enabled — so
-- this seed only makes the current state explicit and syncable; ON CONFLICT
-- keeps a later manual toggle intact on re-runs. NOW() watermark ensures
-- already-enrolled devices receive the row via incremental /sync/pull.
INSERT INTO app_config (key, value, updated_at)
VALUES ('demo_mode', '1', NOW())
ON CONFLICT (key) DO NOTHING;
