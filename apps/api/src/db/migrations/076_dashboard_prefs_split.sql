-- Migration 076: split dashboard_prefs into per-field columns (#193/#196
-- follow-up). Mirrors mobile migration 062.
--
-- dashboard_prefs (migration 075) multiplexed BOTH the personal layout
-- override and the starred-widget set into one JSON TEXT blob. Every mobile
-- setter had to read-merge-write the whole blob with no version check, so a
-- device with a stale local replica would silently clobber the OTHER field on
-- its next write (a layout save erasing an already-synced star set from
-- another device). Splitting into dashboard_layout/starred_widgets lets each
-- field ride its OWN column-scoped upsert (routes/sync.ts's generic push path
-- already only SETs the columns present in a given payload), the same
-- mechanism that already protects theme from a dashboard-prefs write.
--
-- TEXT deliberately (never a PG enum/jsonb column type change — see the
-- unit_category remap incident): each column holds a JSON-stringified array,
-- same shape mobile already round-trips through JSON.stringify/JSON.parse.
--
-- dashboard_prefs is left in place (dead), not dropped — same "don't drop a
-- synced column" precedent as prior migrations; nothing reads it going
-- forward except this one-time backfill and the mobile client's legacy-blob
-- fallback for a row it pulled before running its own migration 062.
--
-- Backfill assumes dashboard_prefs, where non-NULL, is well-formed JSON (the
-- only writer has ever been JSON.stringify via the mobile app) — the
-- jsonb_typeof/array_length guards below just skip a sub-field that's
-- missing/not-an-array/empty, matching mobile 062's "leave NULL, don't write
-- an empty array" backfill rule.
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS dashboard_layout TEXT;
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS starred_widgets TEXT;

UPDATE user_prefs
SET dashboard_layout = (dashboard_prefs::jsonb -> 'layout')::text
WHERE dashboard_prefs IS NOT NULL
  AND jsonb_typeof(dashboard_prefs::jsonb -> 'layout') = 'array'
  AND jsonb_array_length(dashboard_prefs::jsonb -> 'layout') > 0;

UPDATE user_prefs
SET starred_widgets = (dashboard_prefs::jsonb -> 'starred')::text
WHERE dashboard_prefs IS NOT NULL
  AND jsonb_typeof(dashboard_prefs::jsonb -> 'starred') = 'array'
  AND jsonb_array_length(dashboard_prefs::jsonb -> 'starred') > 0;
