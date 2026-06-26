# Task 2 Report — Query-layer helpers + sync-enabled appendLog

## Files Changed

- `apps/mobile/src/db/queries/users.ts` — added `getUsersByRole(role: string): User[]`
- `apps/mobile/src/db/queries/locations.ts` — added `getLocationsByOwner(ownerUserId: string): Location[]`
- `apps/mobile/src/db/queries/log.ts` — added `import { appendOutbox } from '../../sync/outbox'` and the `appendOutbox('INSERT', 'activity_log', { ... })` call at the end of `appendLog`

## tsc Result

`cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json` → **exit 0**, no errors or warnings.

## appendOutbox Signature Confirmed

```typescript
export function appendOutbox(
  operation: OutboxOperation,
  table_name: string,
  payload: Record<string, unknown>
): void
```
Source: `apps/mobile/src/sync/outbox.ts` lines 17-21. Call in `log.ts` matches exactly.

## Circular-Import Check

`apps/mobile/src/sync/outbox.ts` imports only:
- `'../db/schema'` (getDb)
- `'../utils/uuid'` (generateUUID)

It does **not** import from `db/queries/log.ts` or any file in `db/queries/`. No circular dependency.

## Observations / Concerns

None. `rowsAs` was already imported in all three target files before this task. The `appendLog` signature is unchanged; the outbox call appends after the local INSERT using the same `id` and `created_at` that were just generated.

## Commit

`94ea873` — `feat(queries): getUsersByRole, getLocationsByOwner, sync-enable appendLog`
