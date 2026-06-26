## Task 2: `equipmentUnits.ts` query module

**Files:** create `apps/mobile/src/db/queries/equipmentUnits.ts`.

**Interfaces — Produces:**
```typescript
export interface EquipmentUnit {
  id: string; item_id: string; asset_tag: string; serial_number: string | null;
  status: string; current_location_id: string | null; current_job_id: string | null;
  notes: string | null; created_at: string; updated_at: string; synced_at: string | null;
}
export function getUnitsForItem(itemId: string): EquipmentUnit[]
export function getAvailableUnitsAtLocation(itemId: string, locationId: string): EquipmentUnit[]
export function getUnitByTag(tag: string): EquipmentUnit | null
export function getDeployedUnitsForUser(userId: string): (EquipmentUnit & { item_name: string; job_name: string | null })[]
export function countUnitsByStatus(itemId: string): { available: number; deployed: number; in_repair: number; retired: number }
export function upsertUnit(u: EquipmentUnit): void  // local + caller outboxes
export function setUnitStatus(unitId: string, p: { status: string; current_location_id?: string | null; current_job_id?: string | null; notes?: string | null }): EquipmentUnit
```

- [ ] **Step 1: Implement the module.** Use `getDb()/executeSync/rowsAs/bindParams` like the other query files. Key bodies:
```typescript
export function getUnitsForItem(itemId: string): EquipmentUnit[] {
  const db = getDb();
  return rowsAs<EquipmentUnit>(db.executeSync(
    `SELECT * FROM equipment_units WHERE item_id = ? ORDER BY asset_tag`, [itemId]).rows);
}
export function getAvailableUnitsAtLocation(itemId: string, locationId: string): EquipmentUnit[] {
  const db = getDb();
  return rowsAs<EquipmentUnit>(db.executeSync(
    `SELECT * FROM equipment_units WHERE item_id = ? AND status = 'available' AND current_location_id = ? ORDER BY asset_tag`,
    [itemId, locationId]).rows);
}
export function getUnitByTag(tag: string): EquipmentUnit | null {
  const db = getDb();
  return (db.executeSync(`SELECT * FROM equipment_units WHERE asset_tag = ?`, [tag]).rows[0] as unknown as EquipmentUnit) ?? null;
}
export function countUnitsByStatus(itemId: string) {
  const db = getDb();
  const rows = db.executeSync(`SELECT status, COUNT(*) AS n FROM equipment_units WHERE item_id = ? GROUP BY status`, [itemId]).rows as { status: string; n: number }[];
  const out = { available: 0, deployed: 0, in_repair: 0, retired: 0 } as Record<string, number>;
  for (const r of rows) out[r.status] = r.n;
  return out as { available: number; deployed: number; in_repair: number; retired: number };
}
export function getDeployedUnitsForUser(userId: string) {
  // Units currently deployed, whose most recent checkout_to_job log was by this user.
  const db = getDb();
  return db.executeSync(
    `SELECT eu.*, i.name AS item_name, j.name AS job_name
     FROM equipment_units eu
     JOIN inventory_items i ON i.id = eu.item_id
     LEFT JOIN jobs j ON j.id = eu.current_job_id
     WHERE eu.status = 'deployed'
       AND EXISTS (SELECT 1 FROM activity_log al WHERE al.user_id = ?
                   AND al.action = 'checkout_to_job' AND al.note = 'unit ' || eu.asset_tag)
     ORDER BY eu.asset_tag`, [userId]).rows as any[];
}
export function upsertUnit(u: EquipmentUnit): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO equipment_units
       (id, item_id, asset_tag, serial_number, status, current_location_id, current_job_id, notes, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindParams([u.id, u.item_id, u.asset_tag, u.serial_number, u.status, u.current_location_id, u.current_job_id, u.notes, u.created_at, u.updated_at, u.synced_at]));
}
export function setUnitStatus(unitId: string, p: { status: string; current_location_id?: string | null; current_job_id?: string | null; notes?: string | null }): EquipmentUnit {
  const db = getDb();
  const now = new Date().toISOString();
  const cur = db.executeSync(`SELECT * FROM equipment_units WHERE id = ?`, [unitId]).rows[0] as unknown as EquipmentUnit;
  const next: EquipmentUnit = {
    ...cur, status: p.status,
    current_location_id: p.current_location_id !== undefined ? p.current_location_id : cur.current_location_id,
    current_job_id: p.current_job_id !== undefined ? p.current_job_id : cur.current_job_id,
    notes: p.notes !== undefined ? p.notes : cur.notes,
    updated_at: now, synced_at: null,
  };
  upsertUnit(next);
  return next;
}
```
Callers of `upsertUnit`/`setUnitStatus` also `appendOutbox('INSERT','equipment_units', {...row, updated_at})` with the returned row (full upsert; send no booleans — all unit fields are string/null).

- [ ] **Step 2: tsc** exit 0.
- [ ] **Step 3: commit** `feat(equipment): equipment_units query module`.

---

