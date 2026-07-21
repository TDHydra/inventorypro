# Quick Photo Capture — Design (issue #148)

Date: 2026-07-19
Branch: `feat/148-quick-photo`

## Purpose

Field techs need a one-tap way to photograph a room/area and file it — against a job
when there is one, or into a shared pool when there isn't — without navigating to a
job detail page first. Entry point must be on every screen (header), and the flow must
be fast enough to use one-handed: camera first, then a popup with the keyboard already
open so the phone's built-in mic button covers voice entry.

## UX flow

1. **Header camera icon** (visible to every signed-in user, all dashboards) opens the
   flow.
2. **Destination sheet** — "For a job?":
   - Searchable picker over open jobs (same `SearchablePicker` + `getOpenJobs()`
     pattern as fast-checkout).
   - Or **"No job — share with:"** selector: **My team** / **Everyone** /
     **Specific users** (roster multi-select).
   - The choice is made once per session and persists across "Save & add another".
3. **Native camera** via `expo-image-picker` `launchCameraAsync` — the OS camera's
   built-in retake/OK step is the "retry or done" taxonomy. (Matches existing
   `MediaGallery.handleCamera()`.)
4. **Detail popup** opens immediately after capture:
   - **Room/Area** input, autofocused (keyboard up ⇒ mic/voice available), with
     autofill suggestions from previously entered values
     (`getLocationNoteSuggestions`, backed by `media.location_note`).
   - **Note** input, optional, no suggestions.
   - Buttons: **Done** (save, close, confirmation toast) ·
     **Save & add another** (save, reopen camera, keep job/audience) ·
     **Cancel** (discard this photo; confirm via `ConfirmSheet` if fields are dirty).
5. Photos attached to a job appear in that job's existing `MediaGallery`
   automatically. Pool photos appear in the Media hub filtered by audience
   visibility.

Cancelling the destination sheet or the camera exits the flow silently.

## Header restyle (same PR)

- Add camera icon button to `headerRight` in `apps/mobile/app/(app)/_layout.tsx`,
  left of the bells.
- Replace the "Switch" text button with a compact logout-style icon
  (same behavior: routes to `/(auth)/login`, or `logout()` for test sessions).
- Reduce header title text size so the row fits comfortably.

## Data model

Reuse the existing `media` table (MinIO presigned upload + outbox sync already
work for it). No new tables.

| Field | Use here |
|---|---|
| `entity_type` / `entity_id` | `'job'` + job id when a job was picked; `'pool'` + uploader's user id when not |
| `location_note` | Room/Area value (existing column, existing suggestions query) |
| `caption` | Optional note |
| `audience` (NEW, TEXT) | `NULL` for job photos; `'team'` \| `'everyone'` \| `'users'` for pool photos |
| `audience_user_ids` (NEW, TEXT/JSON array) | Only when `audience='users'` |

- `audience` is **TEXT, not a Postgres ENUM** (per the enum-trap rule).
- Migrations: one server SQL migration; one mobile migration registered in **both**
  `schema.ts` and `schema.web.ts` import arrays (web-migrations rule).
- Job photos are unchanged rows — zero effect on existing data or flows.

## Server changes

- `apps/api/src/lib/syncPolicy.ts`: add `'pool'` to `MEDIA_ENTITY_TYPES`; extend the
  media column allowlist with `audience`, `audience_user_ids`; validate audience
  values and that `audience_user_ids` is a JSON array of UUIDs when
  `audience='users'`.
- `apps/api/src/routes/sync.ts`: extend `mediaScopeSql` so a user pulls a pool photo
  when any of: they uploaded it; `audience='everyone'`; `audience='team'` and they
  share the uploader's team; `audience='users'` and their id is in
  `audience_user_ids`.
- `apps/api/src/routes/media.ts`: allow `'pool'` in the upload-url entity allowlist.
- Deploy = migration applies on boot (deploy-api skill).

## Mobile components

- `QuickPhotoButton` — header icon; renders for all users.
- `QuickPhotoFlow` — modal component mounted once in `(app)/_layout.tsx`; state
  machine `destination → camera → details → (loop|close)`. Pure logic (state
  transitions, payload building) lives in `quickPhotoLogic.ts` for unit testing.
- Reuses: `SearchablePicker`, `AutofillTextField` (or `SuggestInput`) for Room/Area,
  `TextField` for note, `ModalSheet`/`FormSheet`, `ConfirmSheet` for dirty-cancel,
  `Toast`, and `uploadCore.ts` for the actual upload + outbox insert.
- Media hub: pool photos surface under existing media browsing with an audience
  filter chip (minimal — just enough to find non-job photos).

## Error handling

- Camera permission denied → toast with settings hint, flow closes.
- Upload failure/offline → row + outbox entry are written locally first (existing
  `uploadCore` behavior); sync retries when online. No user-facing error unless the
  local write fails.
- 25 MB cap and extension checks inherited from `uploadCore`/server.

## Testing

- Unit: `quickPhotoLogic.test.ts` — destination branching (job vs each audience),
  save-&-add-another loop keeps destination, cancel/dirty paths, payload building
  (`audience` columns null for job photos).
- Unit (API): `syncPolicy` media validation for audience values/UUID list;
  scope SQL cases if harness allows.
- Column-parity: update `pullColumns.test.ts` expectations for the two new columns.
- Device: build dev APK + hotload (CLAUDE.md rule) after each phase; verify camera,
  keyboard autofocus, voice entry via keyboard mic, autofill suggestions, and that a
  job photo lands in the job gallery.

## Out of scope

- Custom in-app camera UI, in-app speech-to-text, editing audience after upload
  (can reassign to a job via existing media detail sheet if already supported),
  iOS build, notifications on shared photos.
