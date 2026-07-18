# Backlog: make checkout/checkin photos retrievable

*Captured 2026-06-26 (from the job-mgmt+media integration review).*

Checkout and check-in now let you attach an optional photo on the confirm screen
(`MediaGallery entityType="checkout"|"checkin"`). The upload works, but the media is
keyed to a **throwaway UUID** generated for the confirm action — NOT the move's
`activity_log` id — and no screen queries `entity_type='checkout'|'checkin'`. So the
photos are currently **write-only / orphaned** (stored in MinIO + media table, but not
viewable anywhere).

**To make them useful (follow-up):**
1. Key the media to the move's `activity_log` row id (the `appendLog` already generates
   one; thread it out / use a known id so the photo's `entity_id` = the log id).
2. Show move-photos somewhere they're reachable — e.g. a thumbnail on the activity-log
   entry (the Phase-2b logging screens), or on the job detail's activity list, or the
   item's history.

Entity media (items, jobs, locations) is already fully viewable (detail screens +
list thumbnails) — this only affects the per-move event photos.
