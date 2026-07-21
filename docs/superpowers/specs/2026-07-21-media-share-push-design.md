# Instant media sharing — quick-photo capture + push (#87 + #148)

Date: 2026-07-21
Builds on: `docs/superpowers/specs/2026-07-19-quick-photo-capture-design.md` (#148 — adopted verbatim)
Closes: #148 (capture flow) and #87 (instant push + view).

## Problem

Field techs need to snap a photo and have the right people see it *now*. The #148 spec
designs the capture half (header camera → job or audience pool) but explicitly left
"notifications on shared photos" out of scope. #87 is exactly that missing half: recipient
gets an immediate push and views the photo in-app. Decisions from review: build #148 as
specified, add push on top; push fires for `users` and `team` audiences, **not** `everyone`
(inbox-only — no company-wide push blasts); job photos unchanged, no push.

## Part 1 — Capture flow & data model: #148 spec, adopted verbatim

Everything in `2026-07-19-quick-photo-capture-design.md` stands: header `QuickPhotoButton`
on every screen, `QuickPhotoFlow` state machine (`destination → camera → details →
(loop|close)`) with pure logic in `quickPhotoLogic.ts`, native camera via the existing
`MediaGallery.handleCamera()` idiom, Room/Area autofill from `media.location_note`,
Done / Save-&-add-another / Cancel, reuse of `SearchablePicker`/`ModalSheet`/`ConfirmSheet`/
`uploadCore.ts`.

Data model as specified there: reuse `media`; new **TEXT** columns `audience`
(`NULL` | `'team'` | `'everyone'` | `'users'`) and `audience_user_ids` (JSON array of user
UUIDs, only when `audience='users'`); `entity_type='pool'` + `entity_id` = uploader's user id
for non-job photos. Server: `syncPolicy.ts` allows `'pool'` + validates audience columns;
`mediaScopeSql` in `routes/sync.ts` extended so a user pulls a pool photo when they uploaded
it, `audience='everyone'`, shares the uploader's team (`'team'`), or is listed
(`'users'`); `routes/media.ts` upload-url allowlist gains `'pool'`.

Migration numbers are assigned at implementation time, not here: re-check
`apps/mobile/src/db/migrations/` and `apps/api/src/db/migrations/` right before creating
them, and coordinate with the vehicles track's standing reservations (mobile 052/053,
API 064/065 for #152/#155) — take the next numbers after whatever exists + is reserved.
The mobile migration goes in BOTH `schema.ts` and `schema.web.ts` arrays. Follow
`docs/SYNC-MIGRATION-CHECKLIST.md` for the synced-column adds (incl. `pullColumns.test.ts`
parity).

## Part 2 — Push delivery (the #87 half)

Server-side hook in `/sync/push` (`apps/api/src/routes/sync.ts`), mirroring the existing
chat-message push hook (~L1588): after persisting a `media` **INSERT** with
`entity_type='pool'`:

- Resolve recipients: `audience='users'` → the listed user ids; `'team'` → all members of
  the uploader's team(s) (`team_members` join, same resolution the chat/notifications code
  uses); `'everyone'` → **no push** (deliberately quiet). Exclude the uploader. De-dupe.
- Route through the existing `deliver()` funnel (`apps/api/src/lib/notifications.ts`) with
  `urgency='urgent'`: every recipient — including `'everyone'`-audience users when they next
  sync — gets a durable notifications-inbox row; push goes out via Expo (`lib/push.ts`) to
  registered devices only.
- Copy: title = sharer's name, body = `Shared a photo${location_note ? ` — ${location_note}` : ''}`.
- Payload: `data: { screen: 'media', mediaId: <media.id> }`.
- UPDATEs to media rows do not re-push (INSERT only). Failures in push resolution must not
  fail the sync push (same error isolation as the chat hook).

## Part 3 — Viewing

`src/push/handlers.ts` gains a `screen === 'media'` case deep-linking to the photo (media
hub detail / existing viewer) with the `mediaId`. Race handling: the push can arrive before
the recipient's device has pulled the row — on open, trigger a drain-and-pull
(`runDrainAndPull`) and show a loading state until the media row lands, then render (same
shape as the chat deep-link). The notifications-inbox entry taps through to the same place.

## Out of scope

Everything #148 excluded (custom camera UI, in-app speech-to-text, audience editing after
upload, iOS build) plus: pushes for `audience='everyone'`, pushes on job photos, read
receipts, any new tables beyond the two columns.

## Deployment

API change + migration ⇒ prod deploy via deploy-api (**now the VPS VM at 192.168.1.72**, not
Unraid). Mobile is dev-client hotloadable (no native deps added); field release APK later.
Old APKs simply never see pool photos (scope SQL additive) — no compat break.

## Testing

- Unit (mobile): `quickPhotoLogic.test.ts` per the #148 spec (destination branching,
  save-&-add-another loop, dirty-cancel, payload building — audience columns null for job
  photos).
- Unit (API): audience→recipient resolution incl. exclusion of uploader, de-dupe, 'everyone'
  → no push; `syncPolicy` validation (audience enum, UUID-array check); scope-SQL cases in
  the sync-guards/mediaScope test harness.
- Parity: `pullColumns.test.ts` + web `schema.web.ts` migration registration.
- Device (two logins): share to a specific user → push lands on second device → tap →
  photo opens; share to team → teammates pushed; share to everyone → no push but appears in
  media hub + inbox; job photo → lands in job gallery, no push.
