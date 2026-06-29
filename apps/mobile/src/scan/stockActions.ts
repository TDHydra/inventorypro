import { adjustStock } from '../db/queries/items';
import { appendOutbox } from '../sync/outbox';
import { appendLog } from '../db/queries/log';

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
}
