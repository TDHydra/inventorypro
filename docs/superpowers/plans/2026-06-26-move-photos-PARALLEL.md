# Retrievable Move-Photos (+ scanning touch-up) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`. **Verification gate:** no unit-test runner — gate per task is `npx tsc --noEmit` clean (controller, app-wide) + the task's manual check. Implementer agents do **NO git and NO tsc**; the controller runs unified tsc, commits per task, reviews.

**Goal:** Make checkout/check-in photos retrievable by keying them to the move's `activity_log` row and surfacing a 📷 thumbnail on `ActivityFeed`; plus swap the last plain tag input (Quick-Add Equipment) to the scannable `BarcodeInput`.

**Architecture:** `appendLog` gains an optional `id`; checkout/check-in pass their existing event id as the primary move-log id and point `MediaGallery` at `entity_type="activity_log"`; `ActivityFeed` rows show a media thumbnail + lightbox; `EquipmentQuickAdd` uses `BarcodeInput`. JS-only — no migration/native (ships over Metro).

**Tech Stack:** Expo SDK 56, expo-router, `@op-engineering/op-sqlite`, expo-camera (existing).

## Global Constraints

- Expo SDK 56 — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- op-sqlite bind params: only `string | number | null | ArrayBuffer`.
- `appendLog` self-enqueues its own `activity_log` outbox row — never separately outbox an activity_log row.
- No migration, no native module, no new permission. Reuse `media`/`getPrimaryMedia`/`getMediaForEntity`/`MediaGallery`/`ActivityFeed`/`BarcodeInput`.
- Additive / degrade cleanly: no photo → no thumbnail; `appendLog`'s new `id?` is optional so existing callers are unaffected.
- `activity_log` insert is idempotent by `id` server-side — a known id is safe.
- Full Shared Context Pack in the spec: `docs/superpowers/specs/2026-06-26-move-photos-design.md` — every task brief ships with it.

---

# WAVE 0 (T1 + T3 disjoint, parallel) → then T2

### Task 1: `appendLog` optional id + ActivityFeed media thumbnail

**Files:** Modify `apps/mobile/src/db/queries/log.ts`, `apps/mobile/src/components/ActivityFeed.tsx`

**Interfaces — Produces:**
- `appendLog` entry accepts optional `id?: string`; the row id = `entry.id ?? generateUUID()`.
- `ActivityFeed` rows render a 📷 thumbnail when `getPrimaryMedia('activity_log', row.id)` is non-null.

- [ ] **Step 1: appendLog id.** In `log.ts`, add `id?: string` to the `appendLog` entry param type, and change the internal id generation to `const id = entry.id ?? generateUUID();` (keep everything else — the INSERT, the outbox payload, all use this `id`). `generateUUID` is already imported. Existing callers omit `id` → unchanged.
- [ ] **Step 2: ActivityFeed thumbnail.** In `ActivityFeed.tsx`, import `getPrimaryMedia` + `getMediaForEntity` from `../db/queries/media` and `Image`/`Modal`/`TouchableOpacity` from react-native. For each rendered row, compute `const photo = getPrimaryMedia('activity_log', r.id);` If `photo`, render a small (e.g. 36×36, rounded) `Image source={{uri: photo.thumbnail_url ?? photo.url}}` at the row's trailing edge wrapped in a `TouchableOpacity` that sets `lightbox = getMediaForEntity('activity_log', r.id)` (an array). Add a lightbox `Modal` (transparent, fade) showing the photos full-screen — reuse the lightbox pattern from `MediaGallery.tsx` (tap to close; if multiple, a simple horizontal `ScrollView`/pager so all of a mixed-equipment move's pictures are viewable). Rows without a photo render exactly as today.
- [ ] **Step 3 (controller): verify** `npx tsc --noEmit` clean.
- [ ] **Step 4 (controller): commit** `feat(log): appendLog optional id + ActivityFeed move-photo thumbnail/lightbox`.

### Task 3: Scanning touch-up — Quick-Add Equipment uses BarcodeInput

**Files:** Modify `apps/mobile/src/components/quickadd/EquipmentQuickAdd.tsx`
**Consumes:** existing `BarcodeInput` (`src/components/BarcodeInput.tsx`, props `{label, value, onChange, placeholder, note?, noteTone?}`).
- [ ] **Step 1:** Replace the plain asset-tag `TextInput` (the one bound to `assetTag`/`setAssetTag`) with `<BarcodeInput label="Asset tag" value={assetTag} onChange={setAssetTag} placeholder="AM-0001" />` (import `BarcodeInput`). Keep the dup-tag validation, sticky-item, and "save & add another" behavior. Drop the now-unused `tagRef`/`autoFocus` wiring if it referenced that TextInput (BarcodeInput owns its field) — ensure no unused-var/type errors.
- [ ] **Step 2 (controller): verify** `npx tsc --noEmit` clean.
- [ ] **Step 3 (controller): commit** `feat(quick-add): equipment tag field scans via BarcodeInput`.

# WAVE 1 (after T1)

### Task 2: Re-key checkout/check-in photos to the move's log row

**Files:** Modify `app/(app)/(checkout)/index.tsx`, `app/(app)/(checkin)/index.tsx`
**Consumes:** Task 1's `appendLog` optional `id`.

- [ ] **Step 1: check-in.** In `(checkin)/index.tsx`: change both `MediaGallery` calls from `entityType="checkin"` to `entityType="activity_log"` (keep `entityId={checkinEventId}` / `{unitCheckinEventId}`). On the corresponding confirm `appendLog` call(s) (the check-in move log), pass `id: checkinEventId` (resp. `unitCheckinEventId`) so the log row shares the id with the photo. (Each check-in confirm path has a single representative log — give it the matching event id.)
- [ ] **Step 2: checkout.** In `(checkout)/index.tsx`: change the `MediaGallery` from `entityType="checkout"` to `entityType="activity_log"` (keep `entityId={checkoutEventId}`). Set `id: checkoutEventId` on the **first/primary** move-confirm `appendLog` call only — do NOT add `id` to the shared `baseLog` spread (that would collide the PK across the multiple unit/PM rows). The remaining move logs keep their default ids. (Read the confirm handler; the first appendLog that represents the move is the one to key.)
- [ ] **Step 3: fresh id per move.** Confirm that after a completed move each screen resets its event id to a new `generateUUID()` (so the next move's photos don't collide with the prior log id). If the screen already re-mounts/resets on completion, preserve that; otherwise reset `checkoutEventId`/`checkinEventId` in the post-confirm cleanup.
- [ ] **Step 4 (controller): verify** `npx tsc --noEmit` clean.
- [ ] **Step 5 (controller): commit** `feat(movement): key checkout/check-in photos to the move's activity_log row (retrievable)`.

---

# SHIP (controller, after all tasks merge)
- [ ] App-wide `npx tsc --noEmit` clean; whole-branch review (opus) vs spec (focus: the re-key id sharing + no PK collision in multi-unit checkout; media entity_type change; degradation).
- [ ] Merge `feat/move-photos` → `main`. **No prod redeploy / no dev-client rebuild** (JS-only). Reaches the dev client via Metro reload; rebuild the **release APK** for standalone.

## Self-Review (controller checklist)
- **Spec coverage:** Unit1→T1 step1; Unit2→T2; Unit3→T1 step2; Unit4→T3. ✔
- **Placeholder scan:** lightbox pattern points at `MediaGallery.tsx` (named source), not a TODO; all changes concrete.
- **Type consistency:** `appendLog` `id?` (T1) consumed by T2; `getPrimaryMedia('activity_log', id)` / `getMediaForEntity` (media.ts) used in T1 step2; `BarcodeInput` prop names (T3) match the component.
- **File-collision check:** T1 = log.ts + ActivityFeed.tsx; T2 = checkout/checkin; T3 = EquipmentQuickAdd.tsx. Disjoint. T1+T3 parallel; T2 after T1 (needs appendLog id). ✔
- **Risk note:** T2's checkout has multiple appendLog paths — the implementer must key exactly ONE (the primary) to avoid an activity_log PK collision; called out explicitly in the task.
