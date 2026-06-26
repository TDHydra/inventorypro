# Task 6 report — Check Out: unit selection for unit-tracked items

**Status:** Complete. tsc clean, committed `8c29ad3`.

## Unit-selection step (qty step, unit-tracked branch)
- `selectedItem.unit_tracked` drives `isUnitTracked`. The flow branches throughout; non-tracked items keep the exact existing UI/logic.
- **Source picker for unit-tracked items is derived from unit locations, not stock_by_location.** Critical finding: unit-tracked items never get `stock_by_location` rows (add.tsx skips `adjustStock` for them — units are added individually). So the existing source picker (driven by `getStockByItem`) would be empty. `handleSelectItem` now calls `buildUnitSourceStock(itemId)`, which groups `getUnitsForItem` (status `available`, with a location) by `current_location_id`, counts them, and emits `StockByLocation`-shaped rows so the existing `SearchablePicker`, `fromLabel`, and `selectedLocation` plumbing all keep working unchanged.
- After a source is chosen, `availableUnits` = `getAvailableUnitsAtLocation(item.id, sourceLocationId)` (useMemo). Rendered as a tap-to-toggle checklist (`✓`), state `selectedUnits: EquipmentUnit[]`.
- Scan-to-add: `BarcodeInput` (value `scanTag`) + an "Add Unit by Tag" button → `addUnitByTag` calls `getUnitByTag(tag)` and validates same item + status `available` + `current_location_id === source`; warns via `Alert` otherwise; adds (dedup by id) on success.
- Changing source clears `selectedUnits`. Next button requires `selectedUnits.length > 0` for unit-tracked (vs `selectedLocation` for non-tracked).

## Per-destination unit transitions (handleConfirm, unit-tracked branch)
Branch returns early **before** any `stockMove`/`stock_by_location` write. Destination validated before any writes; then per selected unit:
- **Job:** `setUnitStatus(u.id,{status:'deployed', current_job_id: job.id, current_location_id: null})`; log `action:'checkout_to_job'`, from=source, to=null, job_id=job.id, quantity=1, note=`'unit '+asset_tag` (so Check In / `getDeployedUnitsForUser` finds it).
- **Location:** `setUnitStatus(u.id,{status:'available', current_location_id: dest.id, current_job_id:null})`; log `action:'transfer'`, from=source, to=dest.id, quantity=1, note=`'unit '+asset_tag`.
- **PM:** uses `pmSelections[0].locationId` as `pmLocationId`; `setUnitStatus(u.id,{status:'available', current_location_id: pmLocationId, current_job_id:null})`; log `action:'transfer'`, from=source, to=pmLocationId, quantity=1, note=`'unit '+asset_tag`.

Each selected unit gets its own `setUnitStatus` + `outboxUnit` + `appendLog` (one log per unit).

## INSERT / no-synced_at handling
- `outboxUnit(u)` writes `appendOutbox('INSERT','equipment_units', {...full row...})` with **`synced_at` intentionally omitted** — matches the existing convention in `(inventory)/[id].tsx` (full upsert keyed by id). Verb is `'INSERT'`, never `'UPDATE'`.
- `appendLog` self-enqueues the activity_log outbox row; no separate activity_log outbox write.

## Non-tracked quantity path
Unchanged. `stockMove`, `stock_by_location` outbox writes, returnable consumed/checkout_to_job logic, qty input, and PM single/multiple-with-quantities flow are all untouched and only reachable when `!isUnitTracked` (the unit branch returns first). Confirm screen rows for non-tracked destinations are now guarded with `!isUnitTracked` so they don't double-render. A unit-tracked item never touches `stock_by_location`; a non-tracked item never touches `equipment_units`.

## Confirm screen (unit-tracked)
Shows Item, From, `Units (N)` = comma-joined asset tags, and the resolved destination (To Job + "Deploy (returnable)" / To Location / To Manager → location). No quantity row.

## Verification
- `npx tsc --noEmit -p tsconfig.json` → exit 0.
- No jest (per instructions).
- **On-device testing PENDING (human).** Not run in this environment.

## Concerns
- **PM + multiple-PM mode for unit-tracked:** the dest UI still offers single/multiple PMs with per-PM quantities (brief said keep dest UI unchanged). For unit-tracked I assign **all** selected units to `pmSelections[0]`'s location (the brief's single `pmLocationId` model). If a user picks multiple PMs in multiple-mode for a unit-tracked item, only the first manager's location is used. Quantity inputs are meaningless for units. Worth a follow-up to hide multiple-mode / per-PM qty when unit-tracked.
- Source picker sublabel for unit-tracked locations runs the unit count through `formatQuantity` with the item's unit string (cosmetic; counts are correct).

---

## Fix note — Task 6 follow-up (commit `b24b934`)

**What was gated:** When `isUnitTracked && destType === 'pm'`, the single/multiple toggle is now fully suppressed (`{!isUnitTracked && <View forRow...>}`). Per-PM quantity display and input are suppressed in `PmLocationRow` via a new `hideQty` boolean prop (passed `hideQty={isUnitTracked}` from the single-PM call site).

**How single-mode is forced for unit-tracked:** The ternary that drives the single vs. multiple render path was `pmMode === 'single' ? … : …`. It is now `(isUnitTracked || pmMode === 'single') ? … : …`, so unit-tracked items always enter the single-PM branch regardless of the `pmMode` state variable. Because `resetDest()` resets `pmMode` to `'single'` on every dest-type switch, this guard is mainly a safety net.

**onHand guard:** `const onHand = isUnitTracked ? 0 : getStockQuantity(itemId, source)` — the DB read is skipped entirely for unit-tracked checkouts (they never use `onHand` because the unit-tracked branch returns early before any `onHand` comparison).

**tsc result:** exit 0 (no type errors).
