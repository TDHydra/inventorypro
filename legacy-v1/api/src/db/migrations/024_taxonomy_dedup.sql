-- Migration 024: one-time cleanup of duplicate (category,label) taxonomy_types rows.
-- The table has no UNIQUE(category,label) constraint, so duplicates can be created
-- (e.g. two 'job' rows both labeled "Mold"), which causes duplicate React keys on the
-- client and double entries in every type dropdown. Keep the lowest sort_order per
-- (category,label) — tie-broken by oldest updated_at, then id — and delete the rest.
-- Entities reference taxonomy by label (jobs.type, etc.) and the kept row keeps the
-- same label, so no foreign references break. We intentionally do NOT add a hard
-- UNIQUE constraint: rows sync keyed by id, and a cross-device push of a same-label
-- row with a different id would violate it and wedge the outbox. The app-level guard
-- in addTaxonomyType + the dedup in getTaxonomyTypes prevent recurrence instead.
DELETE FROM taxonomy_types t
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY category, label
           ORDER BY sort_order ASC, updated_at ASC, id ASC
         ) AS rn
  FROM taxonomy_types
) d
WHERE t.id = d.id AND d.rn > 1;
