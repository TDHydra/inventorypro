# Task 6 Report — Check Out destinations (Job / Location / Production Manager)

## Step machine
`type Step = 'find' | 'qty' | 'dest' | 'confirm'` (was `'find'|'qty'|'job'|'confirm'`).

- **find** — unchanged: server-side `searchItems` FlatList + "Scan Barcode Instead" + `itemId` param fast-path. (Kept as a FlatList rather than `SearchablePicker` because the picker only filters a client-provided option array; feeding it server search results / preserving the scan affordance is not natural. SearchablePicker is used for every other selection below.)
- **qty** — source location now via `SearchablePicker` over `getStockByItem(item)` rows (qty>0), sublabel shows parent + on-hand. Quantity TextInput unchanged.
- **dest** — three buttons set `destType: 'job' | 'location' | 'pm'`, then the matching sub-flow renders.
- **confirm** — reuses the `Row` helper + `confirmCard` styles; lists item, source, and resolved destination(s) (multi-PM lists each PM + qty + location). Confirm runs the writes.

The old self/team/office `checkoutFor` state and UI are REMOVED.

## Exact stock writes (all outbox stock rows carry ABSOLUTE post-adjust qty via `getStockQuantity`, never a delta)
Central helper `stockMove(itemId, fromLoc, toLoc, qty)`: `adjustStock(itemId, fromLoc, -qty)` + outbox source absolute; if `toLoc`, `adjustStock(itemId, toLoc, +qty)` + outbox dest absolute.

- **To Job**: `stockMove(item, source, null, qty)` → source **−qty** only. `appendLog({action:'checkout', from_location_id:source, to_location_id:null, job_id:job.id, quantity:qty})`. New jobs created via `onCreate` → `generateUUID` + `upsertJob` + `appendOutbox('INSERT','jobs',…)` then selected.
- **To Location**: `stockMove(item, source, dest, qty)` → source **−qty**, dest **+qty**, two stock outbox INSERTs (each absolute). `appendLog({action:'transfer', from_location_id:source, to_location_id:dest, quantity:qty})`. Dest options exclude the source location.
- **To Production Manager**: single/multiple toggle building `pmSelections: {pmId, pmName, locationId, locationName, qty}[]`.
  - Single: pick one PM (`getUsersByRole('production_manager')`); locations via `getLocationsByOwner(pmId)`; preselect if exactly one else pick; qty = the step quantity → one target.
  - Multiple: toggle-list of PMs; per PM a location picker (preselected if they own exactly one) + per-PM qty input.
  - Per target: `stockMove(item, source, target.locationId, target.qty)` → source **−qty**, PM location **+qty**, both stock outbox INSERTs absolute. `appendLog({action:'checkout', from_location_id:source, to_location_id:target.locationId, quantity:target.qty, note:'PM: '+pmName})`.

`appendLog` enqueues its own `activity_log` outbox row — no extra `appendOutbox('INSERT','activity_log',…)` is done anywhere. Log `entity_type` kept as `'inventory_item'` (matching the prior screen).

## Multi-PM guard
`onHand = getStockQuantity(item, source)` is read once before any write. Confirm blocks (Alert, no writes) if: no targets, any target missing a location, any target qty ≤ 0/NaN, or `sum(target.qty) > onHand`. Because `adjustStock` floors at 0, this guard is what prevents silent over-deduction. Within the per-target loop each source outbox row carries the running absolute on-hand, so the final synced value equals `onHand − sum`.

## tsc
`cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json` → **exit 0**.

## On-device / e2e — PENDING (human)
Brief steps 5–6 (real device: Warehouse→Van transfer, PM split, job checkout, then Postgres stock verification after sync) require a phone and a running backend. Not executable here. A human must run them.

## Concerns
- **Active-checkouts visibility**: per the brief I write `action:'checkout'` for Job/PM. `getActiveCheckoutsForUser` (jobs.ts) filters `action='checkout_to_job' AND entity_type='item'`, so these rows will NOT appear in that existing query. Brief step 5 says a job checkout should "appear in active checkouts" — there is a naming mismatch between the brief's logic-level instruction (`'checkout'`) and the existing query. Followed the explicit instruction; flag for the human to reconcile (either the action string or the query/Task-7).
- **find step** kept as FlatList (not SearchablePicker) — rationale above; all other pickers use SearchablePicker.
- Equipment vs product: both simply deduct source (no kind branching), as specified.

## Action String Fix

Corrected action fields to match the database query expectations:
- **Job checkouts** now write `action: 'checkout_to_job'` (line 264)
- **Production Manager checkouts** now write `action: 'transfer'` (line 306)
- **Location transfers** continue to write `action: 'transfer'` (line 281)

Verification:
```
264:        ...baseLog, action: 'checkout_to_job',
281:        ...baseLog, action: 'transfer',
306:        ...baseLog, action: 'transfer',
```

TypeScript check: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json` → **exit 0** ✓

Commit: 7db5529
