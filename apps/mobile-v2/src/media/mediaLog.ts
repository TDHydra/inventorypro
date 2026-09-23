// Station D2: the old app's media mutations self-logged inside
// db/queries/media.ts (logMediaAction). v2 repos don't self-log — callers wrap
// runInTransaction(mutation + appendLog) (PmContactPopup pattern) — so the
// exact old log-row shape lives here once instead of being retyped at every
// call site (MediaDetailSheet, MediaGallery, hub bulk delete).
import { appendLog } from '../db/queries/log';

export function logMediaAction(
  action: 'media_updated' | 'media_deleted',
  mediaId: string,
  userId: string | null,
  note: string | null,
): void {
  appendLog({
    action,
    entity_type: 'media',
    entity_id: mediaId,
    user_id: userId,
    note,
    team_id: null, from_location_id: null, to_location_id: null,
    quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
  });
}
