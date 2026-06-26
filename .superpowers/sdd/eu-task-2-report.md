# Task 2 Report: `equipmentUnits.ts` query module

## Status: DONE

## File Created
`apps/mobile/src/db/queries/equipmentUnits.ts`

## Exported symbols
- `EquipmentUnit` (interface)
- `getUnitsForItem(itemId: string): EquipmentUnit[]`
- `getAvailableUnitsAtLocation(itemId: string, locationId: string): EquipmentUnit[]`
- `getUnitByTag(tag: string): EquipmentUnit | null`
- `getDeployedUnitsForUser(userId: string): (EquipmentUnit & { item_name: string; job_name: string | null })[]`
- `countUnitsByStatus(itemId: string): { available: number; deployed: number; in_repair: number; retired: number }`
- `upsertUnit(u: EquipmentUnit): void`
- `setUnitStatus(unitId: string, p: { status: string; current_location_id?: string | null; current_job_id?: string | null; notes?: string | null }): EquipmentUnit`

## tsc result
Exit 0, no errors.

## Deviations from brief
None. The module was transcribed exactly as specified. The return type of `getDeployedUnitsForUser` was given a typed signature `(EquipmentUnit & { item_name: string; job_name: string | null })[]` (the brief permitted `any[]` or a typed extension) — the cast `as any[]` in the brief's body still applies internally; the function signature is the typed form. tsc accepted this without issue.

## Commit
`9763842` — `feat(equipment): equipment_units query module`
