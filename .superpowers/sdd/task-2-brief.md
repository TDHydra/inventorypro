## Task 2: Query-layer helpers — `getUsersByRole`, `getLocationsByOwner`, sync-enabled `appendLog`

**Files:**
- Modify: `apps/mobile/src/db/queries/users.ts`
- Modify: `apps/mobile/src/db/queries/locations.ts`
- Modify: `apps/mobile/src/db/queries/log.ts`

**Interfaces:**
- Consumes: `User` (users.ts), `Location` (locations.ts), `appendOutbox` (sync/outbox.ts).
- Produces: `getUsersByRole(role: string): User[]`; `getLocationsByOwner(ownerUserId: string): Location[]`. `appendLog(...)` now also enqueues the row to the sync outbox so on-device moves reach the server's immutable log.

> **Why the appendLog change:** today `appendLog` writes the row to local SQLite only and returns void, so checkout/checkin logs never sync. The server already accepts `activity_log` via idempotent `WHERE NOT EXISTS` inserts on `/sync/push`. Making `appendLog` outbox the exact row it just inserted (same `id` + `created_at`) fixes this for every caller at once — no caller changes needed.

- [ ] **Step 1: getUsersByRole**

In `apps/mobile/src/db/queries/users.ts` add:
```typescript
// Active users of a given role — e.g. the production-manager dropdown in checkout.
export function getUsersByRole(role: string): User[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM users WHERE active = 1 AND role = ? ORDER BY name`,
    [role]
  );
  return rowsAs<User>(result.rows);
}
```

- [ ] **Step 2: getLocationsByOwner**

In `apps/mobile/src/db/queries/locations.ts` add:
```typescript
// Locations that belong to a user (a PM's locker/vehicle, etc.).
export function getLocationsByOwner(ownerUserId: string): Location[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM locations WHERE owner_user_id = ? ORDER BY name`,
    [ownerUserId]
  );
  return rowsAs<Location>(result.rows);
}
```

- [ ] **Step 3: Sync-enable `appendLog`**

In `apps/mobile/src/db/queries/log.ts`, import the outbox and make `appendLog` enqueue the same row after inserting it locally:
```typescript
import { getDb, rowsAs } from '../schema';
import { generateUUID } from '../../utils/uuid';
import { appendOutbox } from '../../sync/outbox';
```
```typescript
export function appendLog(entry: Omit<LogEntry, 'id' | 'created_at' | 'synced_at'>): void {
  const db = getDb();
  const id = generateUUID();
  const created_at = new Date().toISOString();
  db.executeSync(
    `INSERT INTO activity_log
       (id, user_id, team_id, action, entity_type, entity_id,
        from_location_id, to_location_id, quantity, unit, job_id,
        note, metadata, device_id, created_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, entry.user_id, entry.team_id, entry.action, entry.entity_type,
     entry.entity_id, entry.from_location_id, entry.to_location_id,
     entry.quantity, entry.unit, entry.job_id, entry.note,
     entry.metadata, entry.device_id, created_at]
  );
  // Sync the row to the server's append-only log (idempotent insert server-side).
  appendOutbox('INSERT', 'activity_log', {
    id, user_id: entry.user_id, team_id: entry.team_id, action: entry.action,
    entity_type: entry.entity_type, entity_id: entry.entity_id,
    from_location_id: entry.from_location_id, to_location_id: entry.to_location_id,
    quantity: entry.quantity, unit: entry.unit, job_id: entry.job_id,
    note: entry.note, metadata: entry.metadata, device_id: entry.device_id, created_at,
  });
}
```

- [ ] **Step 4: Compile gate**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 5: e2e verify a log syncs**

Trigger any log (e.g. add stock in a later task, or temporarily call appendLog) and confirm it reaches Postgres:
```bash
sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"SELECT action, count(*) FROM activity_log GROUP BY action ORDER BY action\""
```
Expected: `add_stock`/`checkout`/`checkin`/`transfer` rows appear after on-device actions (verified end-to-end in Tasks 4–7).

- [ ] **Step 6: Checkpoint** — `tsc` clean; `appendLog` now enqueues to the outbox.

---

