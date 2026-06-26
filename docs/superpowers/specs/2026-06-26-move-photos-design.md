# Retrievable Move-Photos (+ scanning touch-up) — Design Spec

*Date: 2026-06-26 · Branch: `feat/move-photos` · Program Phase 2 of 4*

## Context

Checkout/check-in let you attach an optional photo on the confirm screen, but the media is keyed to
a **throwaway** `checkoutEventId`/`checkinEventId` and no screen queries it — so move-photos are
write-only (stored in MinIO + `media`, viewable nowhere). This phase ties each move-photo to the
move's **activity_log row** and surfaces it as a thumbnail on the existing `ActivityFeed` (job
detail, location detail, unit history). It also closes the last scanning gap: the new Quick-Add
Equipment form still uses a plain tag input while the rest of the app already scans.

> **Scanning is otherwise already done:** `BarcodeScanner.tsx` is a real `CameraView`; `BarcodeInput`
> (used in checkout/check-in + Add-Units) has an inline "Scan" button. Only `EquipmentQuickAdd` lags.

### Decisions locked with the user
1. **Re-key** move-photos to the move's primary `activity_log` row id (reusing the existing
   `checkoutEventId`/`checkinEventId` state as that id).
2. **View** via a 📷 thumbnail on `ActivityFeed` rows that have media → tap → lightbox. No new screen.
3. **Multi-unit checkout:** the one photo binds to the **first/primary** move-confirm log row (single-row
   moves — count moves, single unit, check-in — are unambiguous).
4. **Scanning touch-up:** `EquipmentQuickAdd` tag field → the scannable `BarcodeInput`.

## Global Constraints (apply to every task)

- **Expo SDK 56** — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- **op-sqlite bind params** accept only `string | number | null | ArrayBuffer`; booleans `0/1` locally / real booleans in outbox.
- **`appendLog`** self-enqueues its own `activity_log` outbox row — never separately outbox an activity_log row.
- **No migration, no native module, no new permission** — reuses the `media` table (already syncs), `getPrimaryMedia`, `MediaGallery`, `ActivityFeed`, `BarcodeInput`. Ships over Metro.
- **Additive / degrade cleanly:** no photo → no thumbnail, exactly as today. `appendLog`'s new `id?` is optional → no existing caller changes.
- **`activity_log` is append-only + push-only** (idempotent insert by `id`, server WHERE NOT EXISTS) — using a known id is safe and idempotent.

## Shared Context Pack (authoritative)

- **Logging** — `src/db/queries/log.ts`: `appendLog(entry)` currently generates the row id internally
  (`generateUUID()`); the INSERT idempotency on the server is by `id`. **Add an optional `id?: string`**
  to the entry; use `entry.id ?? generateUUID()`.
- **Media** — `src/db/queries/media.ts`: `getPrimaryMedia(entityType, entityId): MediaRecord | null`,
  `getMediaForEntity(...)`, `MediaRecord{url, thumbnail_url, ...}`. `MediaGallery` (`src/components/MediaGallery.tsx`)
  props `{entityType, entityId, canUpload?}` — already writes `media` rows + outbox.
- **Move flows** — `app/(app)/(checkout)/index.tsx` (`checkoutEventId` state line 81; `MediaGallery entityType="checkout" entityId={checkoutEventId}` line 855; multiple move-confirm `appendLog` calls, several spreading a shared `baseLog`), `app/(app)/(checkin)/index.tsx` (`checkinEventId` line 65; two `MediaGallery entityType="checkin"` at 456/512; count-based + unit-tracked confirm `appendLog` calls).
- **Activity feed** — `src/components/ActivityFeed.tsx`: renders each log row (icon/label/user/qty/note/date) and exports `ACTION_ICONS`/`actionLabel`. Rows are `LogEntry` with `id`.
- **Scanner** — `src/components/BarcodeInput.tsx`: `{label, value, onChange, placeholder, note?, noteTone?}` — text field + inline camera "Scan".
- `generateUUID()` (`src/utils/uuid`).

---

## Architecture (4 units)

### Unit 1 — `appendLog` accepts an optional id
`log.ts`: add optional `id?: string` to the `appendLog` entry param; `const id = entry.id ?? generateUUID();`
(used for both the local INSERT and the outbox payload, exactly as today). No other behavior change; all
existing callers unaffected (they omit `id`).

### Unit 2 — Re-key checkout/check-in photos to the move's log row
In each flow, the `MediaGallery` on the confirm screen changes to `entityType="activity_log"` with
`entityId={checkoutEventId}` / `{checkinEventId}` (the existing state, now meaningful). The **primary**
move-confirm `appendLog` call passes `id: checkoutEventId` (resp. `checkinEventId`) so the log row and the
photo share that id.
- **Check-in** + **count-based / single-unit checkout:** there's one representative confirm log — give it the event id.
- **Multi-unit / multi-action checkout:** set `id` on the **first** move-confirm `appendLog` only (NOT on the
  shared `baseLog` spread — that would collide the PK across rows); the remaining logs keep their default
  generated ids. After confirm, reset the event id (new `generateUUID()`) so the next move starts fresh
  (the screens already re-mount/reset between moves — preserve that).

### Unit 3 — Thumbnail on `ActivityFeed` rows
For each rendered row, look up `getPrimaryMedia('activity_log', row.id)`; if present, render a small 📷
thumbnail (the `thumbnail_url ?? url`) at the row's trailing edge. Tapping it opens a lightbox `Modal`
(reuse the simple full-screen image modal pattern from `MediaGallery`'s lightbox) showing **all** the
move's photo(s) via `getMediaForEntity('activity_log', row.id)` — a mixed-equipment checkout where the
user snapped a different picture per kind shows every one (swipe/scroll through them). Rows without media
render exactly as today.

### Unit 4 — Scanning touch-up
`src/components/quickadd/EquipmentQuickAdd.tsx`: replace the plain asset-tag `TextInput` with `BarcodeInput`
(`value={assetTag} onChange={setAssetTag} label="Asset tag" placeholder="AM-0001"`). Keep the existing
dup-tag validation + sticky-item + "save & add another" behavior. (The `autoFocus`/`ref` refocus may drop,
since `BarcodeInput` owns its input — acceptable; scanning is the point.)

---

## File map

| Unit | Files |
|---|---|
| 1 | `apps/mobile/src/db/queries/log.ts` |
| 2 | `app/(app)/(checkout)/index.tsx`, `app/(app)/(checkin)/index.tsx` |
| 3 | `apps/mobile/src/components/ActivityFeed.tsx` |
| 4 | `apps/mobile/src/components/quickadd/EquipmentQuickAdd.tsx` |

## Verification
- `tsc --noEmit` clean (mobile). No API/migration change.
- Manual: attach a photo on a check-in confirm → the resulting activity-log row (in the unit's history / job detail / location feed) shows a 📷 thumbnail → tap → photo opens. Same for a single-unit + a count checkout. Multi-unit checkout: photo appears on the first action's row.
- Moves with no photo show no thumbnail (unchanged). Existing entity media (item/job/location detail) unaffected.
- Quick-Add Equipment tag field now has a "Scan" button that fills the tag from the camera; dup-tag rejection still works.

## Out of scope (later/backlog)
- Showing the photo on *every* row of a multi-action checkout (chose first-row only).
- A dedicated per-event photo gallery screen (the row lightbox suffices).
- Label/QR generation (separate backlog item).
