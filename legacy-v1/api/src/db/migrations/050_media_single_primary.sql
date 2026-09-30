-- Migration 050: one primary photo per entity (bug #50).
--
-- "First photo on an entity becomes its primary" was decided client-side from a
-- possibly-stale local replica, so two devices uploading to the same empty entity
-- each elected their own primary and both rows survived the push (job "Tw" ended
-- up with two starred photos). The server now owns the invariant: /sync/push
-- coerces a late claim to is_primary = false (see lib/mediaPrimary.ts), and this
-- partial unique index is the hard backstop for the check-then-insert race.
--
-- No mobile mirror: the client stays optimistic (a local unique index could make a
-- pull batch carrying both a demote and a new primary fail mid-cycle). The server
-- is authoritative; the coerced row flows back on the next incremental pull.

-- Repair existing duplicates: keep the earliest claim per entity, demote the rest.
-- updated_at = NOW() so every device pulls the correction (incremental pull is
-- WHERE updated_at > since — without the bump the demote would be invisible).
UPDATE media SET is_primary = FALSE, updated_at = NOW()
WHERE is_primary
  AND id NOT IN (
    SELECT DISTINCT ON (entity_type, entity_id) id
    FROM media
    WHERE is_primary
    ORDER BY entity_type, entity_id, created_at ASC, id ASC
  );

CREATE UNIQUE INDEX IF NOT EXISTS media_one_primary_idx
  ON media (entity_type, entity_id)
  WHERE is_primary;
