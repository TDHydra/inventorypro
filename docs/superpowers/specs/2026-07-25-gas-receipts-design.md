# Gas receipts (#168) — wave 2 design

**Date:** 2026-07-25. Approved in-session after brainstorm.
Builds on schema phase 0 (merged `70d2fca`): `vehicle_service_records.payer` + `.job_id`,
`createServiceRecord({ payer, jobId })`, `FUEL_UP_TYPE`, media `entity_type='service_record'`
accepted end-to-end, and `src/db/gasReceiptPayers.ts` (get/set/subscribe/notify, code default
`['Teams','Office','Contents','Construction']`). **No migrations.** Wave 1 (#152/#155/#167)
shipped 2026-07-25 @ `7d37828`.

## Decisions made during brainstorm

| Question | Decision |
|---|---|
| Entry points | BOTH: vehicle-page button (vehicle fixed) + QuickAdd hub entry (picker defaults to active checkout) |
| Photo | Optional, **nudged** — saving without one shows a warning state, never blocks |
| Form surface | New dedicated `GasReceiptSheet`; `AddServiceRecordSheet` untouched |
| Data model | A receipt IS a `fuel_up` service record + optional `service_record` media (settled in phase 0 — no new table) |

## 1. `GasReceiptSheet` (new, `src/components/vehicles/GasReceiptSheet.tsx`)

FormSheet-based (dirty-guard + busy/submit plumbing, precedent `AddServiceRecordSheet`).
Props: `{ visible, onClose, lockedVehicleId?: string }` — when `lockedVehicleId` is set
(vehicle-page entry) the vehicle field renders as a fixed label; when absent (QuickAdd entry)
it's a SearchablePicker over active vehicles, **defaulting to
`getActiveCheckoutForUser(userId)`'s vehicle** when a checkout is open.

Fields, top to bottom:
- **Photo** — capture/pick via `expo-image-picker`, upload through `uploadMediaAsset`
  (`src/media/upload.ts` + `.web.ts` twin) with `entity_type: 'service_record'`,
  `entity_id: <record id>`. Optional; when saving without one, the submit path shows a
  one-time inline warning ("No receipt photo attached — save anyway?" via `confirmSheet`).
  Offline: the RECORD always commits locally (offline-first), but the photo upload is
  online-only (presigned PUT — there is no offline media queue). On upload failure the
  record stays saved and the user is told the photo didn't attach (`MediaTooLargeError`
  gets its own message, matching QuickPhotoFlow).
- **Payer** — REQUIRED. Chip row (Pressable + StatusPill, the repo's chip idiom) fed by
  `getGasReceiptPayers()` — the list is short by design (settings guard, min 1); component subscribes via `subscribeGasReceiptPayers` +
  `getGasReceiptPayersVersion` (useSyncExternalStore pattern) so settings edits show live.
  Stored as TEXT snapshot on the record (`payer` column) — renames never rewrite history.
- **Vehicle** — see props above. If the user has an open checkout and picks a DIFFERENT
  vehicle, allow it and append an activity-log note on the created record's log entry
  (pure builder `buildReceiptVehicleMismatchNote(checkedOutName, chosenName)` in
  `vehicleSessionLogic.ts`, node:test covered).
- **Gallons** (optional, numeric — folded into notes via existing `buildFuelUpNotes`).
- **Date** (DateField, defaults today), **Mileage** (odometer, optional numeric).
- **Job** — optional; SearchablePicker + `getOpenJobs()` (QuickPhotoFlow precedent).
- **Cost** — only when `view_financial_data` (mirrors `AddServiceRecordSheet`).
- **Notes** — optional multiline.

Submit calls `createServiceRecord({ vehicleLocationId, target: 'vehicle',
type: FUEL_UP_TYPE, payer, jobId, odometer, cost, eventDate, notes: buildFuelUpNotes(...),
userId })`, then uploads the photo (if any) against the returned record id.

## 2. Entry points

- **Vehicle page**: "Add Gas Receipt" button rendered with the service log section on
  VehiclePanel (full variant), opening the sheet with `lockedVehicleId=locationId`.
  Ungated like the existing Log Service action (crew-level write).
- **QuickAdd hub**: new `app/(app)/(quickadd)/gas-receipt.tsx` route rendering a
  `src/components/quickadd/GasReceiptQuickAdd.tsx` wrapper (every QuickAdd entry is a
  screen — match that pattern exactly), no `lockedVehicleId`.

## 3. Payer settings editor

New `app/(app)/(admin)/gas-receipt-payers.tsx`, mirroring `hidden-fields.tsx`:
`system_settings`-gated, list of current payers with add / rename / remove (TextField +
row actions; simple — no drag reorder), each mutation in `runInTransaction` with an
activity-log entry, then `notifyGasReceiptPayersChanged()`. Writes via
`setGasReceiptPayers(list)` (already outbox-wired). Guard: refuse emptying the list
(min 1 payer) — the form requires a payer. Register the screen in the admin section's
nav list alongside Hidden Fields.

## 4. Display

- `ServiceRecordList` / `VehicleHistoryPanel` fuel-up rows: append the payer to the
  subtitle when present ("Fuel-up · Office") and a 📷 indicator when the record has media
  (existing media count query pattern). Viewing goes through existing media surfaces
  (media hub / detail sheet) — no new gallery work.

## 5. Testing & verification

- node:test: payer-list parse already covered (`gasReceiptPayers.logic`); add
  `buildReceiptVehicleMismatchNote` cases.
- Suites green (mobile 593 baseline post-wave-1, API 417) + tsc both apps.
- Device hotload pass: receipt from vehicle page, receipt from QuickAdd with checkout
  default, payer required enforcement, no-photo nudge, settings edit reflects live in the
  form, offline save + later photo sync. Board: #168 → Done after device verification.

## Out of scope

- OCR / amount extraction from the photo. Receipt approval workflows.
- Payer list reorder UI; per-payer analytics.
- Wave 3 (#174 fuel gauge — needs migration; #175 odometer graphic) and #176 server-side
  vehicles column guard.
