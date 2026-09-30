import { adjustStock } from '../db/queries/items';
import { appendOutbox } from '../sync/outbox';
import { appendLog } from '../db/queries/log';
import { runInTransaction } from '../db/tx';
import { getUnitInventoryLockForUserId } from '../db/queries/access';

export interface ConsumableAction {
  itemId: string;
  unit: string;
  direction: 'in' | 'out';
  qty: number;
  sourceLocationId: string | null; // required for 'out'
  destLocationId: string | null;   // credited location (location/manager/office); null for job or in
  jobId: string | null;            // set when checking out to a job
  userId: string | null;
  note: string | null;
  coords?: { latitude: number | null; longitude: number | null; accuracy: number | null };
}

// Apply a consumable check-in/out as signed stock deltas (server merges
// authoritatively) + an activity_log row. Mirrors checkout's stockMove/appendLog.
export function applyConsumableAction(a: ConsumableAction): void {
  const stamp = () => new Date().toISOString();

  // Guard: a check-in with no resolvable destination would log activity without
  // ever crediting stock — inventory "appears" with no stock trace. Reject it up
  // front, before any write, so the caller (group D) can surface the message.
  if (a.direction === 'in' && a.destLocationId == null && a.sourceLocationId == null) {
    throw new Error('Check-in requires a destination location.');
  }

  // #162 team-scoped unit inventory: stock may not move INTO or OUT OF a
  // Vehicle/Locker owned by another team without manage_other_team_inventory.
  // Checked before any write; the thrown reason surfaces in the callers'
  // "Could not save" alerts. The server enforces the same rule on push, so this
  // only converts a guaranteed sync rejection into an immediate, explained no-op.
  for (const locId of [a.sourceLocationId, a.destLocationId]) {
    const lock = getUnitInventoryLockForUserId(a.userId, locId);
    if (lock.locked) {
      throw new Error(lock.reason ?? "This unit's inventory belongs to another team.");
    }
  }

  // All stock deltas + the activity_log row are one atomic unit: a mid-flow
  // failure (e.g. source deducted but the destination credit throws) must roll
  // back cleanly. Exceptions propagate to the caller — do NOT swallow here.
  runInTransaction(() => {
    if (a.direction === 'out') {
      if (a.sourceLocationId) {
        adjustStock(a.itemId, a.sourceLocationId, -a.qty);
        appendOutbox('ADJUST', 'stock_by_location', {
          item_id: a.itemId, location_id: a.sourceLocationId, delta: -a.qty, updated_at: stamp(),
        });
      }
      if (a.destLocationId) {
        adjustStock(a.itemId, a.destLocationId, a.qty);
        appendOutbox('ADJUST', 'stock_by_location', {
          item_id: a.itemId, location_id: a.destLocationId, delta: a.qty, updated_at: stamp(),
        });
      }
    } else {
      const loc = a.destLocationId ?? a.sourceLocationId;
      if (loc) {
        adjustStock(a.itemId, loc, a.qty);
        appendOutbox('ADJUST', 'stock_by_location', {
          item_id: a.itemId, location_id: loc, delta: a.qty, updated_at: stamp(),
        });
      }
    }

    appendLog({
      action: a.direction === 'out' ? (a.jobId ? 'checkout_to_job' : 'transfer') : 'checkin',
      entity_type: 'item', entity_id: a.itemId,
      user_id: a.userId, team_id: null,
      from_location_id: a.direction === 'out' ? a.sourceLocationId : null,
      to_location_id: a.destLocationId,
      quantity: a.qty, unit: a.unit, job_id: a.jobId, note: a.note,
      metadata: null, device_id: null,
      latitude: a.coords?.latitude ?? null,
      longitude: a.coords?.longitude ?? null,
      location_accuracy: a.coords?.accuracy ?? null,
    });
  });
}
